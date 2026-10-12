import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { advertisers, ads, createAdsDb, createDb } from '../db';
import { pagination } from '../lib/http';
import { getRegion } from '../lib/region';
import { optionalAuthMiddleware } from '../middleware/auth';
import { checkRate } from '../middleware/rateLimit';
import { parseJsonArray } from '../services/admin/i18n';
import { schoolFilterId } from '../services/admin/schoolCodes';
import { ADS_VERSION_KEY, cachedJson, versionedKey } from '../services/admin/adCache';
import { isSafeTargetUrl } from './admin/ads';

/**
 * /api/v1/promotions/ (named to dodge ad blockers,
 * not /ads/): the public ad list and the view / click events.
 *
 * Ads are read from the ads database (DB_ADS); school ids come from the main
 * DB. Views and clicks are written to Workers Analytics Engine (AD_EVENTS),
 * never to D1.
 */
export const promotionRoutes = new Hono<AppEnv>();

/** Rate limit for view / click events. */
const AD_STATS_RATE = '60/min';
/** How long a public ad list stays cached; admin writes bump ads:ver so edits show at once. */
const ACTIVE_TTL = 300;

/** An ad the public may see right now: active, in its run, and its advertiser active. */
function liveConds(now: string): SQL[] {
  return [eq(ads.isActive, 1), lte(ads.startDate, now), gte(ads.endDate, now), eq(advertisers.isActive, 1)];
}

/** Ad slots that exist; anything else matches no ad (and is never cached). */
export const AD_POSITIONS = ['home_banner'] as const;

promotionRoutes.get('/active/', async (c) => {
  await checkRate(c, 'ads_active', '120/min');
  const region = await getRegion(c);
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  if (!region) return c.json(page.wrap([], 0));
  const position = c.req.query('position') ?? '';
  if (position && !(AD_POSITIONS as readonly string[]).includes(position)) return c.json(page.wrap([], 0));
  // Resolve ?school= to an id first: the cache key holds only validated values,
  // so random query strings cannot each mint a KV entry.
  const schoolParam = c.req.query('school') ?? '';
  const schoolId = schoolParam ? await schoolFilterId(createDb(c.env.DB), region.code, schoolParam) : null;
  if (schoolParam && !schoolId) return c.json(page.wrap([], 0));
  const key = await versionedKey(c.env.KV, ADS_VERSION_KEY, 'ads:active', [region.code, position, schoolId ?? '', page.limit, page.offset]);
  // Only the rows are cached; the pagination links are built for this request.
  const cachedPage = await cachedJson(c.env.KV, key, ACTIVE_TTL, async () => {
    const adsDb = createAdsDb(c.env.DB_ADS);
    const now = new Date().toISOString();
    const conds: SQL[] = [
      ...liveConds(now),
      // An advertiser flagged all_regions is shown everywhere, as the admin UI
      // describes it; otherwise only in its explicit regions.
      sql`(${advertisers.allRegions} = 1 OR EXISTS (SELECT 1 FROM advertiser_regions ar WHERE ar.advertiser_id = ${advertisers.id} AND ar.region_code = ${region.code}))`,
    ];
    if (position) conds.push(eq(ads.position, position));
    if (schoolId) {
      conds.push(
        sql`(${advertisers.allSchools} = 1 OR EXISTS (SELECT 1 FROM advertiser_schools ads_s WHERE ads_s.advertiser_id = ${advertisers.id} AND ads_s.school_id = ${schoolId}))`,
      );
    } else {
      conds.push(eq(advertisers.allSchools, 1));
    }
    const where = and(...conds);
    const [{ n }] = await adsDb.select({ n: count() }).from(ads).innerJoin(advertisers, eq(advertisers.id, ads.advertiserId)).where(where);
    const rows = await adsDb
      .select({ a: ads, name: advertisers.companyName })
      .from(ads)
      .innerJoin(advertisers, eq(advertisers.id, ads.advertiserId))
      .where(where)
      .orderBy(desc(ads.createdAt), desc(ads.id))
      .limit(page.limit)
      .offset(page.offset);
    const results = rows.map(({ a, name }) => ({
      id: a.id,
      title: a.title,
      image_url: a.imageUrl,
      // Never hand the app a link it should not follow (rows predating the
      // admin's URL check included).
      target_url: isSafeTargetUrl(a.targetUrl) ? a.targetUrl : '',
      position: a.position,
      headline: a.headline,
      subheadline: a.subheadline,
      slot_index: a.slotIndex,
      advertiser_name: name,
      labels: parseJsonArray<string>(a.labels),
      show_in_hero: !!a.showInHero,
    }));
    return { results, count: n };
  });
  return c.json(page.wrap(cachedPage?.results ?? [], cachedPage?.count ?? 0));
});

/**
 * A short, non-reversible per-day client id: SHA-256 of the signed-in user id
 * (else CF-Connecting-IP + User-Agent) plus the UTC date. Lets the admin
 * count daily uniques without storing who anyone is.
 */
export async function clientHash(c: Context<AppEnv>, now = new Date()): Promise<string> {
  const userId = c.get('userId');
  const who = userId ? `u:${userId}` : `a:${c.req.header('CF-Connecting-IP') ?? ''}|${c.req.header('User-Agent') ?? ''}`;
  const day = now.toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${who}|${day}`));
  return [...new Uint8Array(buf, 0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One Analytics Engine data point per hit. An unknown id is 404; an ad that
 * exists but is not live (inactive, outside its run, advertiser inactive)
 * answers 204 without recording anything.
 */
function recordEvent(event: 'view' | 'click') {
  return async (c: Context<AppEnv>) => {
    await checkRate(c, 'ad_stats', AD_STATS_RATE);
    const raw = c.req.param('id') ?? '';
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return c.json({ detail: 'Not found.' }, 404);
    const adId = Number(raw);
    const adsDb = createAdsDb(c.env.DB_ADS);
    const [row] = await adsDb
      .select({
        position: ads.position,
        live: sql<number>`(${and(...liveConds(new Date().toISOString()))})`,
      })
      .from(ads)
      .innerJoin(advertisers, eq(advertisers.id, ads.advertiserId))
      .where(eq(ads.id, adId))
      .limit(1);
    if (!row) return c.body(null, 404);
    if (!row.live) return c.body(null, 204);
    const region = await getRegion(c);
    c.env.AD_EVENTS?.writeDataPoint({
      indexes: [String(adId)],
      blobs: [event, region?.code ?? '', row.position, await clientHash(c)],
      doubles: [1],
    });
    return c.body(null, 204);
  };
}

promotionRoutes.post('/:id/view/', optionalAuthMiddleware(), recordEvent('view'));
promotionRoutes.post('/:id/click/', optionalAuthMiddleware(), recordEvent('click'));
