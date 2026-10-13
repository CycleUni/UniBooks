import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { cities, createDb, regionVerifications, schoolRequests, schools, users, type Database, type School } from '../../db';
import { apiError, fieldErrors, pagination, readJson, validate } from '../../lib/http';
import { localized, parseJsonObject, resolveLanguage } from '../../services/admin/i18n';
import { assertInScope, intId, likeContains, notFound, regionExists, regionParam, scopeOf } from '../../services/admin/scope';
import { dedupeCode, deriveCode, isValidCode, normalizeCode, regionCodes } from '../../services/admin/schoolCodes';

/** Free-mail and public suffixes that must never mark someone as a student. */
const NON_CAMPUS_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.com.tw',
  'yahoo.com.hk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'qq.com',
  '163.com',
  'proton.me',
  'protonmail.com',
  'edu.tw',
  'edu.hk',
  'com.tw',
  'com.hk',
  'org.tw',
  'org.hk',
]);

/**
 * A school's campus email domain, normalised exactly as sign-in matches it
 * (lowercase, no leading @): a hostname with at least two labels that is
 * not a free-mail provider or bare public suffix. Null when invalid.
 */
export function normalizeEmailDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.trim().toLowerCase().replace(/^@+/, '');
  if (d.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null;
  if (NON_CAMPUS_DOMAINS.has(d)) return null;
  return d;
}
import { writeAudit } from '../../services/admin/audit';

/** Schools and school requests. */
export const schoolRoutes = new Hono<AppEnv>();

const INVALID = 'admin.errInvalidField';

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type SchoolRow = School & { cityCode: string | null; userCount: number };

function schoolJson(s: SchoolRow, lang: string | null) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    display_name: lang ? localized(s.translations, lang, 'name', s.name) : s.name,
    email_domain: s.emailDomain,
    translations: parseJsonObject(s.translations),
    region: s.regionCode,
    city: s.cityCode,
    user_count: s.userCount,
  };
}

const userCountSql = sql<number>`(SELECT count(*) FROM ${regionVerifications} WHERE ${regionVerifications.schoolId} = ${schools.id})`;

function schoolSelect(db: Database) {
  return db
    .select({
      id: schools.id,
      regionCode: schools.regionCode,
      code: schools.code,
      name: schools.name,
      emailDomain: schools.emailDomain,
      translations: schools.translations,
      cityId: schools.cityId,
      isActive: schools.isActive,
      createdAt: schools.createdAt,
      cityCode: cities.code,
      userCount: userCountSql,
    })
    .from(schools)
    .leftJoin(cities, eq(cities.id, schools.cityId));
}

/** Name, code, email domain, or a localized name in any language. */
export function schoolSearch(q: string): SQL {
  const like = likeContains(q);
  return or(
    sql`${schools.name} LIKE ${like} ESCAPE '\\'`,
    sql`${schools.code} LIKE ${like} ESCAPE '\\'`,
    sql`${schools.emailDomain} LIKE ${like} ESCAPE '\\'`,
    sql`EXISTS (SELECT 1 FROM json_each(${schools.translations}) je WHERE json_type(je.value) = 'object' AND json_extract(je.value, '$.name') LIKE ${like} ESCAPE '\\')`,
  )!;
}

async function loadSchool(c: Context<AppEnv>, id: number): Promise<SchoolRow> {
  const scope = await scopeOf(c);
  const db = createDb(c.env.DB);
  const where = scope === null ? eq(schools.id, id) : and(eq(schools.id, id), inArray(schools.regionCode, scope));
  const [row] = await schoolSelect(db).where(where).limit(1);
  if (!row) notFound();
  return row;
}

// ---------------------------------------------------------------------------
// Schools: list / create
// ---------------------------------------------------------------------------

schoolRoutes.get('/schools/', async (c) => {
  const db = createDb(c.env.DB);
  const scope = await scopeOf(c);
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const conds: SQL[] = [];
  if (scope !== null) conds.push(scope.length ? inArray(schools.regionCode, scope) : sql`0`);
  const q = c.req.query('q');
  if (q) conds.push(schoolSearch(q));
  const region = regionParam(c);
  if (region) conds.push(eq(schools.regionCode, region));
  const where = conds.length ? and(...conds) : undefined;
  const [{ n }] = await db.select({ n: count() }).from(schools).where(where);
  const rows = await schoolSelect(db).where(where).orderBy(asc(schools.id)).limit(page.limit).offset(page.offset);
  const lang = await resolveLanguage(c);
  return c.json(
    page.wrap(
      rows.map((r) => schoolJson(r, lang)),
      n,
    ),
  );
});

const translationsSchema = z.record(z.string(), z.unknown(), { message: INVALID });

const schoolCreate = z.object({
  code: z.string({ message: INVALID }).optional(),
  name: z.string({ message: INVALID }).min(1, INVALID).max(255, INVALID),
  email_domain: z
    .string({ message: INVALID })
    .transform((v, ctx) => normalizeEmailDomain(v) ?? (ctx.addIssue({ code: 'custom', message: INVALID }), z.NEVER)),
  translations: translationsSchema.optional(),
  region: z.string({ message: INVALID }).min(1, INVALID),
  city: z.string({ message: INVALID }).nullable().optional(),
});
const schoolUpdate = schoolCreate.partial();

async function cityIn(db: Database, regionCode: string, cityCode: string): Promise<number | null> {
  const [row] = await db
    .select({ id: cities.id })
    .from(cities)
    .where(and(eq(cities.regionCode, regionCode), eq(cities.code, cityCode.trim().toUpperCase())))
    .limit(1);
  return row ? row.id : null;
}

schoolRoutes.post('/schools/', async (c) => {
  const body = validate(schoolCreate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  if (!(await regionExists(db, body.region))) fieldErrors({ region: [INVALID] });

  let code = normalizeCode(body.code);
  if (code && !isValidCode(code)) fieldErrors({ code: ['admin.errSchoolCodeInvalid'] });
  const taken = await regionCodes(db, body.region);
  if (code && taken.has(code)) fieldErrors({ code: ['admin.errSchoolCodeTaken'] });
  let cityId: number | null = null;
  if (body.city && body.city.trim()) {
    cityId = await cityIn(db, body.region, body.city);
    if (cityId === null) fieldErrors({ city: ['admin.errSchoolCityUnknown'] });
  }
  const [dup] = await db.select({ id: schools.id }).from(schools).where(eq(schools.emailDomain, body.email_domain)).limit(1);
  if (dup) fieldErrors({ email_domain: [INVALID] });

  assertInScope(await scopeOf(c), body.region);

  if (!code) code = dedupeCode(deriveCode(body.email_domain), taken);
  const [created] = await db
    .insert(schools)
    .values({
      regionCode: body.region,
      code,
      name: body.name,
      emailDomain: body.email_domain,
      translations: JSON.stringify(body.translations ?? {}),
      cityId,
      createdAt: new Date().toISOString(),
    })
    .returning({ id: schools.id });
  const row = await loadSchool(c, created.id);
  return c.json(schoolJson(row, await resolveLanguage(c)), 201);
});

// ---------------------------------------------------------------------------
// Bulk import (before /schools/:id/ so "bulk" is never read as an id)
// ---------------------------------------------------------------------------

schoolRoutes.post('/schools/bulk/', async (c) => {
  const data = await readJson(c.req);
  const action = data.action;
  const items = data.items ?? [];
  if (!Array.isArray(items)) apiError(400, INVALID);
  const currentRegion = regionParam(c);
  if (!currentRegion) apiError(400, 'admin.errMissingRegion');
  assertInScope(await scopeOf(c), currentRegion);

  const db = createDb(c.env.DB);
  const allSchools = await db.select().from(schools);
  const existingByDomain = new Map(allSchools.map((s) => [s.emailDomain, s]));
  const regionSchools = allSchools.filter((s) => s.regionCode === currentRegion);
  const taken = new Set(regionSchools.map((s) => s.code));
  const codeOwner = new Map(regionSchools.map((s) => [s.code, s.emailDomain]));
  const reserved = new Set(
    items
      .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && !!(i as Record<string, unknown>).code)
      .map((i) => normalizeCode(i.code)),
  );
  const regionCities = new Map((await db.select().from(cities).where(eq(cities.regionCode, currentRegion))).map((ct) => [ct.code, ct]));
  const cityCodes = new Map((await db.select({ id: cities.id, code: cities.code }).from(cities)).map((ct) => [ct.id, ct.code]));

  type Planned = {
    item: Record<string, unknown>;
    existing: School | undefined;
    code: string | null;
    cityGiven: boolean;
    cityId: number | null;
  };
  const planned: Planned[] = [];
  const forbidden: unknown[] = [];
  const badCodes: string[] = [];
  const clashing: string[] = [];
  const badCities: string[] = [];
  let validCount = 0;

  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const domain = normalizeEmailDomain(item.email_domain) ?? '';
    if (!domain) continue;
    item.email_domain = domain;
    validCount++;
    const targetRegion = item.region ? String(item.region) : currentRegion;
    const existing = existingByDomain.get(domain);
    if (targetRegion !== currentRegion || (existing && existing.regionCode !== currentRegion)) {
      forbidden.push(item);
      continue;
    }
    const cityGiven = 'city' in item;
    let cityId: number | null = null;
    if (cityGiven && item.city) {
      const city = regionCities.get(String(item.city).trim().toUpperCase());
      if (!city) {
        badCities.push(domain);
        continue;
      }
      cityId = city.id;
    }
    let code: string | null = null;
    if (item.code) {
      code = normalizeCode(item.code);
      if (!isValidCode(code)) {
        badCodes.push(domain);
        continue;
      }
      const owner = codeOwner.get(code);
      if (owner !== undefined && owner !== domain) {
        clashing.push(domain);
        continue;
      }
    } else if (!existing) {
      code = dedupeCode(deriveCode(domain), new Set([...taken, ...reserved]));
    }
    if (code !== null) {
      if (existing && existing.code !== code) {
        taken.delete(existing.code);
        codeOwner.delete(existing.code);
      }
      taken.add(code);
      codeOwner.set(code, domain);
    }
    planned.push({ item, existing, code, cityGiven, cityId });
  }

  if (badCities.length) apiError(400, 'admin.errSchoolCityUnknown', { domains: badCities });
  if (badCodes.length) apiError(400, 'admin.errSchoolCodeInvalid', { domains: badCodes });
  if (clashing.length) apiError(400, 'admin.errSchoolCodeTaken', { domains: clashing });

  const newItems: unknown[] = [];
  const modified: unknown[] = [];
  const unchanged: unknown[] = [];
  const writes: Parameters<Database['batch']>[0][number][] = [];
  const now = new Date().toISOString();
  const lang = null;

  for (const { item, existing, code, cityGiven, cityId } of planned) {
    const domain = String(item.email_domain);
    const translations = item.translations && typeof item.translations === 'object' ? item.translations : undefined;
    if (!existing) {
      newItems.push({ ...item, code });
      if (action === 'apply') {
        writes.push(
          db.insert(schools).values({
            regionCode: currentRegion,
            code: code!,
            name: typeof item.name === 'string' ? item.name : '',
            emailDomain: domain,
            translations: JSON.stringify(translations ?? {}),
            cityId,
            createdAt: now,
          }),
        );
      }
      continue;
    }
    const name = typeof item.name === 'string' ? item.name : existing.name;
    const oldTranslations = parseJsonObject(existing.translations);
    const newTranslations = 'translations' in item ? (translations ?? {}) : oldTranslations;
    const newCode = code ?? existing.code;
    const newCityId = cityGiven ? cityId : existing.cityId;
    const changed =
      existing.name !== name ||
      JSON.stringify(sortKeys(oldTranslations)) !== JSON.stringify(sortKeys(newTranslations)) ||
      existing.code !== newCode ||
      existing.cityId !== newCityId;
    if (!changed) {
      unchanged.push(item);
      continue;
    }
    modified.push({
      old: schoolJson({ ...existing, cityCode: existing.cityId ? (cityCodes.get(existing.cityId) ?? null) : null, userCount: 0 }, lang),
      new: item,
    });
    if (action === 'apply') {
      writes.push(
        db
          .update(schools)
          .set({ name, translations: JSON.stringify(newTranslations), code: newCode, cityId: newCityId })
          .where(eq(schools.id, existing.id)),
      );
    }
  }

  if (validCount > 0 && forbidden.length === validCount) apiError(403, 'admin.errAllRegionsForbidden');

  if (writes.length) {
    // Codes were settled for the whole batch above; write it in one go so a
    // failure cannot leave half the file applied.
    await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
  }
  // Echo user_count for the "old" rows.
  for (const m of modified as { old: { id: number; user_count: number } }[]) {
    const [{ n }] = await db.select({ n: count() }).from(regionVerifications).where(eq(regionVerifications.schoolId, m.old.id));
    m.old.user_count = n;
  }
  return c.json({ new: newItems, modified, unchanged, forbidden });
});

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Schools: detail
// ---------------------------------------------------------------------------

schoolRoutes.get('/schools/:id/', async (c) => {
  const row = await loadSchool(c, intId(c.req.param('id')));
  return c.json(schoolJson(row, await resolveLanguage(c)));
});

schoolRoutes.patch('/schools/:id/', async (c) => {
  const instance = await loadSchool(c, intId(c.req.param('id')));
  const body = validate(schoolUpdate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  const region = body.region ?? instance.regionCode;
  if (body.region !== undefined && !(await regionExists(db, body.region))) fieldErrors({ region: [INVALID] });

  const set: Partial<School> = {};
  if (body.code !== undefined) {
    const code = normalizeCode(body.code);
    if (code && !isValidCode(code)) fieldErrors({ code: ['admin.errSchoolCodeInvalid'] });
    set.code = code;
  }
  const code = set.code ?? instance.code;
  const taken = await regionCodes(db, region, instance.id);
  if (code && taken.has(code)) fieldErrors({ code: ['admin.errSchoolCodeTaken'] });
  if (set.code === '') {
    // Blank: derived from the domain.
    set.code = dedupeCode(deriveCode(body.email_domain ?? instance.emailDomain), taken);
  }
  if (body.city !== undefined) {
    const cityCode = (body.city ?? '').trim().toUpperCase();
    if (!cityCode) set.cityId = null;
    else {
      const cityId = await cityIn(db, region, cityCode);
      if (cityId === null) fieldErrors({ city: ['admin.errSchoolCityUnknown'] });
      set.cityId = cityId;
    }
  } else if (body.region !== undefined && instance.cityId !== null && body.region !== instance.regionCode) {
    // Moved to another region: its old city is not one of the new region's.
    set.cityId = null;
  }
  if (body.email_domain !== undefined && body.email_domain !== instance.emailDomain) {
    const [dup] = await db.select({ id: schools.id }).from(schools).where(eq(schools.emailDomain, body.email_domain)).limit(1);
    if (dup) fieldErrors({ email_domain: [INVALID] });
    set.emailDomain = body.email_domain;
  }
  if (body.name !== undefined) set.name = body.name;
  if (body.translations !== undefined) set.translations = JSON.stringify(body.translations);
  if (body.region !== undefined) set.regionCode = body.region;

  // perform_update: the school's (new or current) region must be managed.
  assertInScope(await scopeOf(c), region);

  if (Object.keys(set).length) await db.update(schools).set(set).where(eq(schools.id, instance.id));
  const [row] = await schoolSelect(db).where(eq(schools.id, instance.id)).limit(1);
  return c.json(schoolJson(row, await resolveLanguage(c)));
});

schoolRoutes.delete('/schools/:id/', async (c) => {
  const instance = await loadSchool(c, intId(c.req.param('id')));
  // A school with accounts attached cannot be removed: users would silently
  // lose their school. Admins reassign or remove the accounts first.
  if (instance.userCount) apiError(400, 'admin.errDeleteFailed', { count: instance.userCount });
  const db = createDb(c.env.DB);
  await db.delete(schools).where(eq(schools.id, instance.id));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// School requests
// ---------------------------------------------------------------------------

const ADMIN_NOTE_MAX_LENGTH = 2000;
const REQUEST_STATUSES = ['pending', 'added', 'rejected'];

function requestSelect(db: Database) {
  return db.select({ r: schoolRequests, email: users.email }).from(schoolRequests).innerJoin(users, eq(users.id, schoolRequests.userId));
}

function requestJson(row: { r: typeof schoolRequests.$inferSelect; email: string }) {
  const r = row.r;
  return {
    id: r.id,
    user: { id: r.userId, email: row.email },
    region: r.regionCode,
    school_name: r.schoolName,
    school_website: r.schoolWebsite,
    edu_email: r.eduEmail,
    status: r.status,
    admin_note: r.adminNote,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function requestScope(scope: string[] | null): SQL | undefined {
  if (scope === null) return undefined;
  return scope.length ? inArray(schoolRequests.regionCode, scope) : sql`0`;
}

schoolRoutes.get('/school-requests/', async (c) => {
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const conds: (SQL | undefined)[] = [requestScope(await scopeOf(c))];
  const status = c.req.query('status');
  if (status) conds.push(eq(schoolRequests.status, status));
  const q = (c.req.query('q') ?? '').trim();
  if (q) {
    const like = likeContains(q);
    conds.push(
      or(
        sql`${schoolRequests.schoolName} LIKE ${like} ESCAPE '\\'`,
        sql`${schoolRequests.schoolWebsite} LIKE ${like} ESCAPE '\\'`,
        sql`${users.email} LIKE ${like} ESCAPE '\\'`,
        sql`${schoolRequests.eduEmail} LIKE ${like} ESCAPE '\\'`,
      ),
    );
  }
  const region = regionParam(c);
  if (region) conds.push(eq(schoolRequests.regionCode, region));
  const where = and(...conds);
  const [{ n }] = await db.select({ n: count() }).from(schoolRequests).innerJoin(users, eq(users.id, schoolRequests.userId)).where(where);
  const rows = await requestSelect(db)
    .where(where)
    .orderBy(desc(schoolRequests.createdAt), desc(schoolRequests.id))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(page.wrap(rows.map(requestJson), n));
});

async function loadRequest(c: Context<AppEnv>, id: number) {
  const db = createDb(c.env.DB);
  const [row] = await requestSelect(db)
    .where(and(eq(schoolRequests.id, id), requestScope(await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

schoolRoutes.get('/school-requests/:id/', async (c) => c.json(requestJson(await loadRequest(c, intId(c.req.param('id'))))));

schoolRoutes.patch('/school-requests/:id/', async (c) => {
  const id = intId(c.req.param('id'));
  const data = await readJson(c.req);
  const keys = Object.keys(data);
  if (keys.some((k) => k !== 'status' && k !== 'admin_note')) apiError(400, 'admin.errForbiddenField');
  if (!keys.length) apiError(400, INVALID);
  const newStatus = data.status;
  if ('status' in data && (typeof newStatus !== 'string' || !REQUEST_STATUSES.includes(newStatus))) {
    apiError(400, 'admin.errInvalidStatus');
  }
  let note = data.admin_note;
  if ('admin_note' in data) {
    if (note === null) note = '';
    if (typeof note !== 'string' || note.length > ADMIN_NOTE_MAX_LENGTH) apiError(400, INVALID);
  }
  // Looked up after validation but before any write, region-scoped.
  const before = await loadRequest(c, id);
  const db = createDb(c.env.DB);
  const set: Partial<typeof schoolRequests.$inferInsert> = { updatedAt: new Date().toISOString() };
  if ('status' in data) set.status = newStatus as string;
  if ('admin_note' in data) set.adminNote = note as string;
  await db.update(schoolRequests).set(set).where(eq(schoolRequests.id, id));
  const after = await loadRequest(c, id);
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'admin.school_request_updated',
      meta: {
        school_request_id: id,
        old_status: before.r.status,
        new_status: after.r.status,
        note_changed: 'admin_note' in data,
      },
      targetType: 'school_request',
      targetId: id,
    },
    c,
  );
  return c.json(requestJson(after));
});
