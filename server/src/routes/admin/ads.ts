import { Hono } from 'hono';
import { inList } from '../../lib/sql';
import type { Context } from 'hono';
import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import {
  advertiserRegions,
  advertisers,
  advertiserSchools,
  ads,
  createAdsDb,
  createDb,
  regions,
  schools,
  users,
  type Ad,
  type Advertiser,
  type AdsDatabase,
  type Database,
} from '../../db';
import { apiError, fieldErrors, pagination, readJson, validate } from '../../lib/http';
import { likeContains, notFound, regionParam, scopeOf, intId } from '../../services/admin/scope';
import { ADS_VERSION_KEY, bumpVersion } from '../../services/admin/adCache';
import { adCounts, ZERO_COUNTS, type AdCounts } from '../../services/admin/adAnalytics';
import {
  AD_CONTENT_TYPES,
  contentTypeForExt,
  deleteAdImage,
  isInternalImage,
  MAX_UPLOAD_BYTES,
  publicUrl,
  resolveAdImage,
  sniffImage,
  TMP_AD_PREFIX,
  tmpAdKey,
  validatedContentLength,
} from '../../services/admin/uploads';
import { declaredType, readCapped } from '../../lib/body';
import { signToken, verifyToken, InvalidTokenError } from '../../lib/jwt';
import { parseJsonArray } from '../../services/admin/i18n';

/**
 * Ads admin, exposed as sponsors/ and promotions/ (named to dodge ad
 * blockers).
 *
 * Advertisers and ads live in the ads database (DB_ADS); regions, schools
 * and users they point at are checked against the main DB (DB). Every write
 * bumps `ads:ver` so the cached public ad list changes at once.
 */
export const adRoutes = new Hono<AppEnv>();

const INVALID = 'admin.errInvalidField';
const origin = (c: Context<AppEnv>) => new URL(c.req.url).origin;

// ---------------------------------------------------------------------------
// Scope: a region manager *sees* advertisers that run everywhere or in one of
// their regions, and the ads of those advertisers. They may only *change*
// one (or its ads) that runs in their regions alone — see canWrite.
// ---------------------------------------------------------------------------

function advertiserScope(scope: string[] | null, idCol: SQL | typeof advertisers.id = advertisers.id): SQL | undefined {
  if (scope === null) return undefined;
  const inManaged = scope.length
    ? sql`EXISTS (SELECT 1 FROM ${advertiserRegions} ar WHERE ar.advertiser_id = ${idCol} AND ar.region_code IN (${sql.join(
        scope.map((s) => sql`${s}`),
        sql`, `,
      )}))`
    : sql`0`;
  return sql`(EXISTS (SELECT 1 FROM ${advertisers} a2 WHERE a2.id = ${idCol} AND a2.all_regions = 1) OR ${inManaged})`;
}

// ---------------------------------------------------------------------------
// Advertisers ("sponsors")
// ---------------------------------------------------------------------------

/**
 * Whether a region manager may modify an advertiser running in these regions:
 * never one that runs everywhere, never one with no regions, and only when
 * every region is one they manage. Superusers (scope null) always may.
 */
export function canWrite(scope: string[] | null, allRegions: boolean, regionCodes: string[]): boolean {
  if (scope === null) return true;
  return !allRegions && regionCodes.length > 0 && regionCodes.every((r) => scope.includes(r));
}

function assertCanWrite(scope: string[] | null, allRegions: boolean, regionCodes: string[]) {
  if (!canWrite(scope, allRegions, regionCodes)) apiError(403, 'admin.errRegionForbidden');
}

async function storedRegions(adb: AdsDatabase, advertiserId: number): Promise<string[]> {
  const rows = await adb
    .select({ code: advertiserRegions.regionCode })
    .from(advertiserRegions)
    .where(eq(advertiserRegions.advertiserId, advertiserId));
  return rows.map((r) => r.code);
}

/** 403 unless the caller may modify this (stored) advertiser. */
async function assertAdvertiserWritable(c: Context<AppEnv>, adb: AdsDatabase, a: Pick<Advertiser, 'id' | 'allRegions'>) {
  const scope = await scopeOf(c);
  if (scope === null) return;
  assertCanWrite(scope, !!a.allRegions, await storedRegions(adb, a.id));
}

/** Make the cached public ad list reflect this write. */
const invalidateAds = (c: Context<AppEnv>) => bumpVersion(c.env.KV, ADS_VERSION_KEY);

async function advertiserRelations(db: AdsDatabase, ids: number[]) {
  const regionsBy = new Map<number, string[]>();
  const schoolsBy = new Map<number, number[]>();
  if (!ids.length) return { regionsBy, schoolsBy };
  for (const r of await db.select().from(advertiserRegions).where(inList(advertiserRegions.advertiserId, ids))) {
    regionsBy.set(r.advertiserId, [...(regionsBy.get(r.advertiserId) ?? []), r.regionCode]);
  }
  for (const s of await db.select().from(advertiserSchools).where(inList(advertiserSchools.advertiserId, ids))) {
    schoolsBy.set(s.advertiserId, [...(schoolsBy.get(s.advertiserId) ?? []), s.schoolId]);
  }
  return { regionsBy, schoolsBy };
}

function advertiserJson(a: Advertiser, regionCodes: string[], schoolIds: number[]) {
  return {
    id: a.id,
    all_regions: !!a.allRegions,
    regions: [...regionCodes].sort(),
    user: a.userId,
    company_name: a.companyName,
    contact_email: a.contactEmail,
    contact_phone: a.contactPhone,
    all_schools: !!a.allSchools,
    schools: [...schoolIds].sort((x, y) => x - y),
    is_active: !!a.isActive,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

async function serializeAdvertisers(db: AdsDatabase, rows: Advertiser[]) {
  const { regionsBy, schoolsBy } = await advertiserRelations(
    db,
    rows.map((a) => a.id),
  );
  return rows.map((a) => advertiserJson(a, regionsBy.get(a.id) ?? [], schoolsBy.get(a.id) ?? []));
}

const advertiserFields = {
  company_name: z.string({ message: INVALID }).trim().min(1, INVALID).max(255, INVALID),
  contact_email: z.email({ message: INVALID }).max(254, INVALID),
  contact_phone: z.string({ message: INVALID }).max(50, INVALID),
  all_regions: z.boolean({ message: INVALID }),
  regions: z.array(z.string({ message: INVALID }), { message: INVALID }),
  all_schools: z.boolean({ message: INVALID }),
  schools: z.array(z.number({ message: INVALID }).int(INVALID), { message: INVALID }),
  is_active: z.boolean({ message: INVALID }),
  user: z.string({ message: INVALID }).nullable(),
};
const advertiserCreate = z.object({
  ...advertiserFields,
  contact_phone: advertiserFields.contact_phone.optional(),
  all_regions: advertiserFields.all_regions.optional(),
  regions: advertiserFields.regions.optional(),
  all_schools: advertiserFields.all_schools.optional(),
  schools: advertiserFields.schools.optional(),
  is_active: advertiserFields.is_active.optional(),
  user: advertiserFields.user.optional(),
});
const advertiserUpdate = z.object(advertiserFields).partial();

/** Reference checks for regions / schools / user (main DB), user uniqueness (ads DB). */
async function checkAdvertiserRefs(db: Database, adb: AdsDatabase, body: { regions?: string[]; schools?: number[]; user?: string | null }) {
  const errors: Record<string, string[]> = {};
  if (body.regions?.length) {
    const found = new Set(
      (await db.select({ code: regions.code }).from(regions).where(inList(regions.code, body.regions))).map((r) => r.code),
    );
    if (body.regions.some((r) => !found.has(r))) errors.regions = [INVALID];
  }
  if (body.schools?.length) {
    const found = new Set((await db.select({ id: schools.id }).from(schools).where(inList(schools.id, body.schools))).map((s) => s.id));
    if (body.schools.some((s) => !found.has(s))) errors.schools = [INVALID];
  }
  if (body.user) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, body.user)).limit(1);
    if (!u) errors.user = [INVALID];
    else {
      const [taken] = await adb.select({ id: advertisers.id }).from(advertisers).where(eq(advertisers.userId, body.user)).limit(1);
      if (taken) errors.user = [INVALID];
    }
  }
  if (Object.keys(errors).length) fieldErrors(errors);
}

adRoutes.get('/sponsors/', async (c) => {
  const db = createAdsDb(c.env.DB_ADS);
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const conds: (SQL | undefined)[] = [advertiserScope(await scopeOf(c))];
  const q = c.req.query('q');
  if (q) {
    const like = likeContains(q);
    conds.push(sql`(${advertisers.companyName} LIKE ${like} ESCAPE '\\' OR ${advertisers.contactEmail} LIKE ${like} ESCAPE '\\')`);
  }
  const region = regionParam(c);
  if (region) {
    conds.push(
      or(
        eq(advertisers.allRegions, 1),
        sql`EXISTS (SELECT 1 FROM ${advertiserRegions} ar WHERE ar.advertiser_id = ${advertisers.id} AND ar.region_code = ${region})`,
      ),
    );
  }
  const where = and(...conds);
  const [{ n }] = await db.select({ n: count() }).from(advertisers).where(where);
  const rows = await db
    .select()
    .from(advertisers)
    .where(where)
    .orderBy(desc(advertisers.createdAt), desc(advertisers.id))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(page.wrap(await serializeAdvertisers(db, rows), n));
});

adRoutes.post('/sponsors/', async (c) => {
  const body = validate(advertiserCreate, await readJson(c.req), INVALID);
  const adb = createAdsDb(c.env.DB_ADS);
  const regionCodes = [...new Set(body.regions ?? [])];
  const schoolIds = [...new Set(body.schools ?? [])];
  await checkAdvertiserRefs(createDb(c.env.DB), adb, { regions: regionCodes, schools: schoolIds, user: body.user });
  assertCanWrite(await scopeOf(c), body.all_regions ?? false, regionCodes);
  const db = adb;
  const now = new Date().toISOString();
  const [row] = await db
    .insert(advertisers)
    .values({
      userId: body.user ?? null,
      companyName: body.company_name,
      contactEmail: body.contact_email,
      contactPhone: body.contact_phone ?? '',
      allRegions: body.all_regions ? 1 : 0,
      allSchools: body.all_schools === false ? 0 : 1,
      isActive: body.is_active === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const writes = [
    ...(regionCodes.length ? [db.insert(advertiserRegions).values(regionCodes.map((r) => ({ advertiserId: row.id, regionCode: r })))] : []),
    ...(schoolIds.length ? [db.insert(advertiserSchools).values(schoolIds.map((s) => ({ advertiserId: row.id, schoolId: s })))] : []),
  ];
  if (writes.length) await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
  await invalidateAds(c);
  return c.json(advertiserJson(row, regionCodes, schoolIds), 201);
});

async function loadAdvertiser(c: Context<AppEnv>, db: AdsDatabase): Promise<Advertiser> {
  const id = intId(c.req.param('id'));
  const [row] = await db
    .select()
    .from(advertisers)
    .where(and(eq(advertisers.id, id), advertiserScope(await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

adRoutes.get('/sponsors/:id/', async (c) => {
  const db = createAdsDb(c.env.DB_ADS);
  const [json] = await serializeAdvertisers(db, [await loadAdvertiser(c, db)]);
  return c.json(json);
});

async function updateAdvertiser(c: Context<AppEnv>) {
  const db = createAdsDb(c.env.DB_ADS);
  const instance = await loadAdvertiser(c, db);
  const scope = await scopeOf(c);
  const stored = await storedRegions(db, instance.id);
  // Both what the advertiser runs in now and what it would run in after.
  assertCanWrite(scope, !!instance.allRegions, stored);
  const body = validate(advertiserUpdate, await readJson(c.req), INVALID);
  const regionCodes = body.regions ? [...new Set(body.regions)] : undefined;
  const schoolIds = body.schools ? [...new Set(body.schools)] : undefined;
  await checkAdvertiserRefs(createDb(c.env.DB), db, {
    regions: regionCodes,
    schools: schoolIds,
    user: body.user !== undefined && body.user !== instance.userId ? body.user : undefined,
  });
  assertCanWrite(scope, body.all_regions ?? !!instance.allRegions, regionCodes ?? stored);
  const set: Partial<Advertiser> = { updatedAt: new Date().toISOString() };
  if (body.company_name !== undefined) set.companyName = body.company_name;
  if (body.contact_email !== undefined) set.contactEmail = body.contact_email;
  if (body.contact_phone !== undefined) set.contactPhone = body.contact_phone;
  if (body.all_regions !== undefined) set.allRegions = body.all_regions ? 1 : 0;
  if (body.all_schools !== undefined) set.allSchools = body.all_schools ? 1 : 0;
  if (body.is_active !== undefined) set.isActive = body.is_active ? 1 : 0;
  if (body.user !== undefined) set.userId = body.user;
  const writes: Parameters<AdsDatabase['batch']>[0][number][] = [db.update(advertisers).set(set).where(eq(advertisers.id, instance.id))];
  if (regionCodes) {
    writes.push(db.delete(advertiserRegions).where(eq(advertiserRegions.advertiserId, instance.id)));
    if (regionCodes.length)
      writes.push(db.insert(advertiserRegions).values(regionCodes.map((r) => ({ advertiserId: instance.id, regionCode: r }))));
  }
  if (schoolIds) {
    writes.push(db.delete(advertiserSchools).where(eq(advertiserSchools.advertiserId, instance.id)));
    if (schoolIds.length)
      writes.push(db.insert(advertiserSchools).values(schoolIds.map((s) => ({ advertiserId: instance.id, schoolId: s }))));
  }
  await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
  await invalidateAds(c);
  const [fresh] = await db.select().from(advertisers).where(eq(advertisers.id, instance.id)).limit(1);
  const [json] = await serializeAdvertisers(db, [fresh]);
  return c.json(json);
}

adRoutes.patch('/sponsors/:id/', updateAdvertiser);
adRoutes.put('/sponsors/:id/', updateAdvertiser);

adRoutes.delete('/sponsors/:id/', async (c) => {
  const db = createAdsDb(c.env.DB_ADS);
  const instance = await loadAdvertiser(c, db);
  await assertAdvertiserWritable(c, db, instance);
  const adImages = await db.select({ imageUrl: ads.imageUrl }).from(ads).where(eq(ads.advertiserId, instance.id));
  await db.batch([
    db.delete(ads).where(eq(ads.advertiserId, instance.id)),
    db.delete(advertiserRegions).where(eq(advertiserRegions.advertiserId, instance.id)),
    db.delete(advertiserSchools).where(eq(advertiserSchools.advertiserId, instance.id)),
    db.delete(advertisers).where(eq(advertisers.id, instance.id)),
  ]);
  await invalidateAds(c);
  for (const a of adImages) await deleteAdImage(c.env, origin(c), a.imageUrl);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Ad image uploads (before promotions/:id/)
// ---------------------------------------------------------------------------

/**
 * Step one of an ad image upload: authorise one image and hand back where to
 * PUT it — uploads/file/ with a short-lived upload token that fixes the key,
 * the type and the size.
 */
adRoutes.post('/promotions/uploads/', async (c) => {
  const data = await readJson(c.req);
  const contentType = typeof data.content_type === 'string' ? data.content_type : '';
  const ext = AD_CONTENT_TYPES[contentType];
  if (!ext) apiError(400, 'admin.errUnsupportedFileType');
  const size = validatedContentLength(data.content_length);
  if (size === null) apiError(400, 'admin.errFileTooLarge');
  const userId = c.get('user')!.id;
  const key = tmpAdKey(userId, ext);
  const token = await signToken(
    'upload',
    { user_id: userId, action: 'ad_image', target_key: key, content_type: contentType, max_bytes: size },
    c.env.JWT_SIGNING_KEY,
  );
  return c.json({
    upload_url: `${origin(c)}/api/v1/admin/promotions/uploads/file/?token=${encodeURIComponent(token)}`,
    photo_url: publicUrl(c.env, origin(c), key),
  });
});

/** Step two: the bytes, checked against the token and their magic bytes. */
adRoutes.put('/promotions/uploads/file/', async (c) => {
  let claims;
  try {
    claims = await verifyToken('upload', c.req.query('token') ?? '', c.env.JWT_SIGNING_KEY);
  } catch (e) {
    if (e instanceof InvalidTokenError) apiError(403, 'listing.errPhotoNotOwned');
    throw e;
  }
  // The token is bound to the staff member who asked for it.
  const userId = c.get('user')!.id;
  if (claims.action !== 'ad_image' || claims.user_id !== userId || !claims.target_key.startsWith(`${TMP_AD_PREFIX}/${userId}/`)) {
    apiError(403, 'listing.errPhotoNotOwned');
  }
  if (declaredType(c.req.raw) !== claims.content_type) apiError(400, 'admin.errUnsupportedFileType');
  const bytes = await readCapped(c.req.raw, Math.min(claims.max_bytes, MAX_UPLOAD_BYTES));
  if (bytes === null) apiError(400, 'admin.errFileTooLarge');
  if (bytes.byteLength === 0) apiError(400, 'admin.errMissingFile');
  const ext = sniffImage(bytes);
  if (!ext || contentTypeForExt(ext) !== claims.content_type) apiError(400, 'admin.errUnsupportedFileType');
  // One upload per token: never overwrite an object already stored.
  if (await c.env.R2.head(claims.target_key)) apiError(403, 'listing.errPhotoNotOwned');
  await c.env.R2.put(claims.target_key, bytes, { httpMetadata: { contentType: claims.content_type } });
  return c.json({ photo_url: publicUrl(c.env, origin(c), claims.target_key) });
});

// ---------------------------------------------------------------------------
// Ads ("promotions")
// ---------------------------------------------------------------------------

function adJson(c: Context<AppEnv>, a: Ad, advertiserName: string, stats: AdCounts = ZERO_COUNTS, statsAvailable = false) {
  return {
    id: a.id,
    advertiser_name: advertiserName,
    is_internal_image: isInternalImage(c.env, origin(c), a.imageUrl),
    advertiser: a.advertiserId,
    title: a.title,
    image_url: a.imageUrl,
    target_url: a.targetUrl,
    position: a.position,
    headline: a.headline,
    subheadline: a.subheadline,
    slot_index: a.slotIndex,
    labels: parseJsonArray<string>(a.labels),
    start_date: a.startDate,
    end_date: a.endDate,
    is_active: !!a.isActive,
    show_in_hero: !!a.showInHero,
    // From Analytics Engine (about three months of history); 0 with
    // stats_available false when the SQL API is not configured.
    clicks_count: stats.clicks,
    views_count: stats.views,
    unique_clicks_count: stats.uniqueClicks,
    unique_views_count: stats.uniqueViews,
    stats_available: statsAvailable,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

/**
 * Where a click on the ad may send someone: an absolute http(s) URL with a
 * real host and no credentials. javascript:, data: and the like never reach
 * the public ad list.
 */
export function isSafeTargetUrl(value: string): boolean {
  if (/\s/.test(value) || value.length > 500) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  return !!u.hostname && (u.hostname.includes('.') || u.hostname === 'localhost');
}

/** Ad labels: at most 3, each at most 15 characters. */
const labelsSchema = z.array(z.string({ message: INVALID }).max(15, INVALID), { message: INVALID }).max(3, INVALID);

const isoDate = z
  .string({ message: INVALID })
  .refine((s) => !Number.isNaN(Date.parse(s)), INVALID)
  .transform((s) => new Date(s).toISOString());

const adFields = {
  advertiser: z.number({ message: INVALID }).int(INVALID),
  title: z.string({ message: INVALID }).min(1, INVALID).max(255, INVALID),
  image_url: z.string({ message: INVALID }).min(1, INVALID).max(500, INVALID),
  target_url: z.string({ message: INVALID }).max(500, INVALID).refine(isSafeTargetUrl, INVALID),
  position: z.enum(['home_banner'], { message: INVALID }),
  headline: z.string({ message: INVALID }).max(255, INVALID),
  subheadline: z.string({ message: INVALID }).max(255, INVALID),
  slot_index: z.number({ message: INVALID }).int(INVALID).min(1, INVALID).max(200, INVALID),
  labels: labelsSchema,
  start_date: isoDate,
  end_date: isoDate,
  is_active: z.boolean({ message: INVALID }),
  show_in_hero: z.boolean({ message: INVALID }),
};
const adCreate = z.object({
  ...adFields,
  position: adFields.position.optional(),
  headline: adFields.headline.optional(),
  subheadline: adFields.subheadline.optional(),
  slot_index: adFields.slot_index.optional(),
  labels: adFields.labels.optional(),
  is_active: adFields.is_active.optional(),
  show_in_hero: adFields.show_in_hero.optional(),
});
const adUpdate = z.object(adFields).partial();

/** Counts come from the public view/click events, never from the admin. */
const READ_ONLY_AD_FIELDS = [
  'id',
  'clicks_count',
  'views_count',
  'unique_clicks_count',
  'unique_views_count',
  'stats_available',
  'created_at',
  'updated_at',
  'advertiser_name',
  'is_internal_image',
];

function stripReadOnly(data: Record<string, unknown>) {
  for (const f of READ_ONLY_AD_FIELDS) delete data[f];
  return data;
}

function adScope(scope: string[] | null): SQL | undefined {
  return advertiserScope(scope, ads.advertiserId as unknown as typeof advertisers.id);
}

function adSelect(db: AdsDatabase) {
  return db.select({ a: ads, name: advertisers.companyName }).from(ads).innerJoin(advertisers, eq(advertisers.id, ads.advertiserId));
}

/**
 * The advertiser the ad is (to be) filed under: it must be visible to the
 * caller (else a field error) and writable by them (else 403).
 */
async function checkAdvertiser(c: Context<AppEnv>, db: AdsDatabase, id: number) {
  const [row] = await db
    .select({ id: advertisers.id, allRegions: advertisers.allRegions })
    .from(advertisers)
    .where(and(eq(advertisers.id, id), advertiserScope(await scopeOf(c))))
    .limit(1);
  if (!row) fieldErrors({ advertiser: [INVALID] });
  await assertAdvertiserWritable(c, db, row);
}

/** 403 unless the caller may modify ads of this (existing) advertiser. */
async function assertAdvertiserIdWritable(c: Context<AppEnv>, db: AdsDatabase, advertiserId: number) {
  if ((await scopeOf(c)) === null) return;
  const [row] = await db
    .select({ id: advertisers.id, allRegions: advertisers.allRegions })
    .from(advertisers)
    .where(eq(advertisers.id, advertiserId))
    .limit(1);
  if (!row) notFound();
  await assertAdvertiserWritable(c, db, row);
}

async function resolveImage(c: Context<AppEnv>, url: string, current: string | null): Promise<string> {
  const res = await resolveAdImage(c.env, origin(c), c.get('user')!.id, url, current);
  if (!res.ok) fieldErrors({ image_url: [res.code] });
  return res.url;
}

adRoutes.get('/promotions/', async (c) => {
  const db = createAdsDb(c.env.DB_ADS);
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const conds: (SQL | undefined)[] = [adScope(await scopeOf(c))];
  const advertiserId = c.req.query('advertiser_id');
  if (advertiserId) {
    if (!/^\d+$/.test(advertiserId)) apiError(400, INVALID);
    conds.push(eq(ads.advertiserId, Number(advertiserId)));
  }
  const q = c.req.query('q');
  if (q) {
    const like = likeContains(q);
    conds.push(sql`(${ads.title} LIKE ${like} ESCAPE '\\' OR ${advertisers.companyName} LIKE ${like} ESCAPE '\\')`);
  }
  const where = and(...conds);
  const [{ n }] = await db.select({ n: count() }).from(ads).innerJoin(advertisers, eq(advertisers.id, ads.advertiserId)).where(where);
  const rows = await adSelect(db).where(where).orderBy(desc(ads.createdAt), desc(ads.id)).limit(page.limit).offset(page.offset);
  // One Analytics Engine query (cached ~5 min) for the whole page.
  const stats = await adCounts(
    c.env,
    rows.map((r) => r.a.id),
  );
  return c.json(
    page.wrap(
      rows.map((r) => adJson(c, r.a, r.name, stats.counts.get(r.a.id), stats.available)),
      n,
    ),
  );
});

adRoutes.post('/promotions/', async (c) => {
  const body = validate(adCreate, stripReadOnly(await readJson(c.req)), INVALID);
  if (body.start_date >= body.end_date) fieldErrors({ end_date: [INVALID] });
  const db = createAdsDb(c.env.DB_ADS);
  await checkAdvertiser(c, db, body.advertiser);
  const imageUrl = await resolveImage(c, body.image_url, null);
  const now = new Date().toISOString();
  const [row] = await db
    .insert(ads)
    .values({
      advertiserId: body.advertiser,
      title: body.title,
      imageUrl,
      targetUrl: body.target_url,
      position: body.position ?? 'home_banner',
      headline: body.headline ?? '',
      subheadline: body.subheadline ?? '',
      slotIndex: body.slot_index ?? 1,
      labels: JSON.stringify(body.labels ?? []),
      startDate: body.start_date,
      endDate: body.end_date,
      isActive: body.is_active === false ? 0 : 1,
      showInHero: body.show_in_hero ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const [{ name }] = await db.select({ name: advertisers.companyName }).from(advertisers).where(eq(advertisers.id, row.advertiserId));
  await invalidateAds(c);
  return c.json(adJson(c, row, name, ZERO_COUNTS, !!(c.env.CF_ACCOUNT_ID && c.env.CF_ANALYTICS_TOKEN)), 201);
});

async function loadAd(c: Context<AppEnv>, db: AdsDatabase) {
  const id = intId(c.req.param('id'));
  const [row] = await adSelect(db)
    .where(and(eq(ads.id, id), adScope(await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

async function adResponse(c: Context<AppEnv>, row: { a: Ad; name: string }) {
  const stats = await adCounts(c.env, [row.a.id]);
  return c.json(adJson(c, row.a, row.name, stats.counts.get(row.a.id), stats.available));
}

adRoutes.get('/promotions/:id/', async (c) => {
  return adResponse(c, await loadAd(c, createAdsDb(c.env.DB_ADS)));
});

async function updateAd(c: Context<AppEnv>) {
  const db = createAdsDb(c.env.DB_ADS);
  const { a: instance } = await loadAd(c, db);
  await assertAdvertiserIdWritable(c, db, instance.advertiserId);
  const body = validate(adUpdate, stripReadOnly(await readJson(c.req)), INVALID);
  const start = body.start_date ?? instance.startDate;
  const end = body.end_date ?? instance.endDate;
  if (start >= end) fieldErrors({ end_date: [INVALID] });
  if (body.advertiser !== undefined && body.advertiser !== instance.advertiserId) await checkAdvertiser(c, db, body.advertiser);

  const set: Partial<Ad> = { updatedAt: new Date().toISOString() };
  if (body.image_url !== undefined && body.image_url !== instance.imageUrl) {
    set.imageUrl = await resolveImage(c, body.image_url, instance.imageUrl);
  }
  if (body.advertiser !== undefined) set.advertiserId = body.advertiser;
  if (body.title !== undefined) set.title = body.title;
  if (body.target_url !== undefined) set.targetUrl = body.target_url;
  if (body.position !== undefined) set.position = body.position;
  if (body.headline !== undefined) set.headline = body.headline;
  if (body.subheadline !== undefined) set.subheadline = body.subheadline;
  if (body.slot_index !== undefined) set.slotIndex = body.slot_index;
  if (body.labels !== undefined) set.labels = JSON.stringify(body.labels);
  if (body.start_date !== undefined) set.startDate = body.start_date;
  if (body.end_date !== undefined) set.endDate = body.end_date;
  if (body.is_active !== undefined) set.isActive = body.is_active ? 1 : 0;
  if (body.show_in_hero !== undefined) set.showInHero = body.show_in_hero ? 1 : 0;
  await db.update(ads).set(set).where(eq(ads.id, instance.id));
  await invalidateAds(c);
  if (set.imageUrl && instance.imageUrl && set.imageUrl !== instance.imageUrl) {
    await deleteAdImage(c.env, origin(c), instance.imageUrl);
  }
  return adResponse(c, await loadAd(c, db));
}

adRoutes.patch('/promotions/:id/', updateAd);
adRoutes.put('/promotions/:id/', updateAd);

adRoutes.delete('/promotions/:id/', async (c) => {
  const db = createAdsDb(c.env.DB_ADS);
  const { a } = await loadAd(c, db);
  await assertAdvertiserIdWritable(c, db, a.advertiserId);
  await db.delete(ads).where(eq(ads.id, a.id));
  await invalidateAds(c);
  await deleteAdImage(c.env, origin(c), a.imageUrl);
  return c.body(null, 204);
});
