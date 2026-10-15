import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { createDb, regions, regionVerifications, type Region } from '../db';
import { apiError } from './http';

/**
 * Region resolution:
 *   ?region= → X-Region → cookie `region` → the signed-in user's single
 *   verified region → CF-IPCountry → DEFAULT_REGION → first active region.
 * Only codes naming an *active* region are accepted, so an arbitrary
 * ?region= can never reach a query or a response.
 *
 * Resolved lazily (after auth has run) and cached on the request.
 */

const ACTIVE_TTL_MS = 60_000;
let activeCache: { at: number; regions: Map<string, Region> } | null = null;

export async function activeRegions(env: AppEnv['Bindings']): Promise<Map<string, Region>> {
  if (activeCache && Date.now() - activeCache.at < ACTIVE_TTL_MS) return activeCache.regions;
  const rows = await createDb(env.DB).select().from(regions).where(eq(regions.isActive, 1));
  activeCache = { at: Date.now(), regions: new Map(rows.map((r) => [r.code.toUpperCase(), r])) };
  return activeCache.regions;
}

/** Drop the isolate's active-region cache (call after an admin edits regions). */
export function invalidateRegionCache() {
  activeCache = null;
}

async function* candidates(c: Context<AppEnv>) {
  const q = c.req.query('region');
  if (q) yield q.toUpperCase();
  const h = c.req.header('X-Region');
  if (h) yield h.toUpperCase();
  const k = getCookie(c, 'region');
  if (k) yield k.toUpperCase();
  const userId = c.get('userId');
  if (userId) {
    const rows = await createDb(c.env.DB)
      .select({ code: regionVerifications.regionCode })
      .from(regionVerifications)
      .where(and(eq(regionVerifications.userId, userId), eq(regionVerifications.isActive, 1)))
      .limit(2);
    if (rows.length === 1) yield rows[0].code.toUpperCase();
  }
  const ip = c.req.header('CF-IPCountry');
  if (ip && ip !== 'XX' && ip !== 'T1') yield ip.toUpperCase();
  yield (c.env.DEFAULT_REGION || 'TW').toUpperCase();
}

/** The request's region, or null when no region is active at all. */
export async function getRegion(c: Context<AppEnv>): Promise<Region | null> {
  const cached = c.get('regionObj');
  if (cached !== undefined) return cached;
  const active = await activeRegions(c.env);
  let resolved: Region | null = null;
  for await (const code of candidates(c)) {
    const hit = active.get(code);
    if (hit) {
      resolved = hit;
      break;
    }
  }
  resolved ??= active.values().next().value ?? null;
  c.set('regionObj', resolved);
  c.set('region', resolved?.code);
  return resolved;
}

/** Like getRegion, but answers 400 sys.errUnknownRegion when nothing resolves. */
export async function requireRegion(c: Context<AppEnv>): Promise<Region> {
  const region = await getRegion(c);
  if (!region) apiError(400, 'sys.errUnknownRegion');
  return region;
}

/** Whether the user holds an active, unexpired verification in `regionCode`. */
export async function isVerifiedIn(env: AppEnv['Bindings'], userId: string, regionCode: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const [row] = await createDb(env.DB)
    .select({ id: regionVerifications.id })
    .from(regionVerifications)
    .where(
      and(
        eq(regionVerifications.userId, userId),
        eq(regionVerifications.regionCode, regionCode),
        eq(regionVerifications.isActive, 1),
        or(isNull(regionVerifications.expiresAt), gt(regionVerifications.expiresAt, nowIso)),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * 403 {"error":{"code":"acct.errUnverifiedInRegion","region":CODE}}
 * when the signed-in user is not verified in `regionCode`.
 */
export async function assertVerifiedIn(c: Context<AppEnv>, regionCode: string): Promise<void> {
  const userId = c.get('userId');
  if (!userId) apiError(401, 'auth.errNotLoggedIn');
  if (!(await isVerifiedIn(c.env, userId, regionCode))) {
    apiError(403, 'acct.errUnverifiedInRegion', { region: regionCode });
  }
}

/** Middleware form of assertVerifiedIn for the request's own region (unsafe methods only). */
export const requireVerifiedInRequestRegion = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const region = await requireRegion(c);
    await assertVerifiedIn(c, region.code);
  }
  await next();
};

/**
 * Cache headers for a viewer-independent answer that depends on the region
 * (and, with `lang`, the language). When the URL alone names both — ?region=
 * is the region resolved and ?lang= is present, as every SPA request has — no
 * Vary is needed, so the browser reuses it across pages. `Vary: Cookie` would
 * defeat that: analytics cookies change on every page view.
 * Otherwise it keeps varying on every input the fallbacks read.
 */
export async function setSharedCache(
  c: Context<AppEnv>,
  { maxAge, staleWhileRevalidate = 0, lang = false }: { maxAge: number; staleWhileRevalidate?: number; lang?: boolean },
): Promise<void> {
  const region = await getRegion(c);
  const urlNamesAll = !!region && c.req.query('region')?.toUpperCase() === region.code && (!lang || !!c.req.query('lang'));
  const swr = staleWhileRevalidate ? `, stale-while-revalidate=${staleWhileRevalidate}` : '';
  c.header('Cache-Control', `public, max-age=${maxAge}${swr}`);
  if (!urlNamesAll) c.header('Vary', lang ? 'Accept-Language, X-Region, Cookie' : 'X-Region, Cookie');
}
