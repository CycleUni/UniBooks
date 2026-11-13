import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, count, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { invalidates } from '../../lib/cache';
import { cities, createDb, regionVerifications, schoolRequests, schools, users, type Database, type School } from '../../db';
import { apiError, fieldErrors, describeIssues, pagination, readJson, validate } from '../../lib/http';
import { LIMITS } from '../../lib/limits';
import { parseJsonObject, parseJsonArray } from '../../lib/json';
import { schoolDomains } from '../../services/accounts/regionData';
import { localized, resolveLanguage } from '../../services/admin/i18n';
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
import { auditInsert, changedFields, writeAudit } from '../../services/admin/audit';

/** Whether two domains are the same or one sits under the other (mail.x.edu.tw / x.edu.tw). */
export function domainsOverlap(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

const DOMAIN_OVERLAP = 'admin.errSchoolDomainOverlaps';

/** Whether a domain is an accepted student domain for a school (the school's website domain, any subdomain of it, or an additional accepted domain). */
export function isAcceptedDomain(domain: string, emailDomain: string, extraDomains: string[]): boolean {
  return domain === emailDomain || domain.endsWith(`.${emailDomain}`) || extraDomains.includes(domain);
}

/**
 * Campus addresses resolve to the most specific matching school domain in
 * any region (services/accounts/edu.ts), so a domain under or over another
 * region's school would pull that school's students into this region. A
 * region manager may only use domains that touch no school outside the
 * regions they manage; admins (scope null) are not limited.
 */
function overlapsUnmanaged(
  scope: string[] | null,
  domain: string,
  all: Pick<School, 'id' | 'regionCode' | 'emailDomain' | 'emailDomains'>[],
  selfId?: number,
) {
  if (scope === null) return false;
  return all.some(
    (s) =>
      s.id !== selfId &&
      !scope.includes(s.regionCode) &&
      schoolDomains({ email_domain: s.emailDomain, email_domains: s.emailDomains }).some((d) => domainsOverlap(domain, d)),
  );
}

async function assertDomainInScope(c: Context<AppEnv>, db: Database, domain: string, selfId?: number): Promise<void> {
  const scope = await scopeOf(c);
  if (scope === null) return;
  const others = await db
    .select({ id: schools.id, regionCode: schools.regionCode, emailDomain: schools.emailDomain, emailDomains: schools.emailDomains })
    .from(schools)
    .where(scope.length ? sql`${schools.regionCode} NOT IN (SELECT value FROM json_each(${JSON.stringify(scope)}))` : undefined);
  if (overlapsUnmanaged(scope, domain, others, selfId)) fieldErrors({ email_domain: [DOMAIN_OVERLAP] });
}

/**
 * Enforces that every domain of a school (primary and additional) is unique
 * across ALL schools and does not overlap with any domain of another school.
 */
async function assertNoDomainConflicts(db: Database, primaryDomain: string, extraDomains: string[], selfId?: number): Promise<void> {
  const others = await db
    .select({ id: schools.id, emailDomain: schools.emailDomain, emailDomains: schools.emailDomains })
    .from(schools)
    .where(selfId !== undefined ? ne(schools.id, selfId) : undefined);

  // Primary domain must not clash or overlap with any other school's extra domains
  for (const s of others) {
    const extras = parseJsonArray<string>(s.emailDomains);
    for (const ed of extras) {
      if (primaryDomain === ed) {
        fieldErrors({ email_domain: [INVALID] });
      }
      if (domainsOverlap(primaryDomain, ed)) {
        fieldErrors({ email_domain: [DOMAIN_OVERLAP] });
      }
    }
  }

  // Each domain in extraDomains must be unique across all schools' primary and extra domains,
  // and must not be a parent or subdomain of another school's domain.
  for (const ed of extraDomains) {
    for (const s of others) {
      const accepted = schoolDomains({ email_domain: s.emailDomain, email_domains: s.emailDomains });
      for (const od of accepted) {
        if (ed === od) {
          fieldErrors({ email_domains: [INVALID] });
        }
        if (domainsOverlap(ed, od)) {
          fieldErrors({ email_domains: [DOMAIN_OVERLAP] });
        }
      }
    }
  }
}

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
    email_domains: parseJsonArray<string>(s.emailDomains),
    student_email_domain: s.studentEmailDomain || '',
    google_domains: parseJsonArray<string>(s.googleDomains),
    translations: parseJsonObject(s.translations),
    region: s.regionCode,
    city: s.cityCode,
    requires_verification: s.requiresVerification === 1,
    allows_student_id_verification: s.allowsStudentIdVerification === 1,
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
      emailDomains: schools.emailDomains,
      studentEmailDomain: schools.studentEmailDomain,
      googleDomains: schools.googleDomains,
      translations: schools.translations,
      cityId: schools.cityId,
      requiresVerification: schools.requiresVerification,
      allowsStudentIdVerification: schools.allowsStudentIdVerification,
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
  // 台 and 臺 are one spelling: fold both the keyword and the stored names.
  const like = likeContains(q.replace(/台/g, '臺'));
  return or(
    sql`REPLACE(${schools.name}, '台', '臺') LIKE ${like} ESCAPE '\\'`,
    sql`${schools.code} LIKE ${like} ESCAPE '\\'`,
    sql`${schools.emailDomain} LIKE ${like} ESCAPE '\\'`,
    sql`EXISTS (SELECT 1 FROM json_each(${schools.emailDomains}) je WHERE je.value LIKE ${like} ESCAPE '\\')`,
    sql`EXISTS (SELECT 1 FROM json_each(${schools.translations}) je WHERE json_type(je.value) = 'object' AND REPLACE(json_extract(je.value, '$.name'), '台', '臺') LIKE ${like} ESCAPE '\\')`,
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

schoolRoutes.get('/schools', async (c) => {
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

const domainArraySchema = z.array(z.string({ message: INVALID }), { message: INVALID }).transform((list, ctx) => {
  const out: string[] = [];
  for (const item of list) {
    const norm = normalizeEmailDomain(item);
    if (!norm) {
      ctx.addIssue({ code: 'custom', message: INVALID });
      return z.NEVER;
    }
    out.push(norm);
  }
  return [...new Set(out)];
});

const studentDomainSchema = z.string({ message: INVALID }).transform((v, ctx) => {
  const trimmed = v.trim().toLowerCase().replace(/^@+/, '');
  if (!trimmed) return '';
  const norm = normalizeEmailDomain(trimmed);
  if (!norm) {
    ctx.addIssue({ code: 'custom', message: INVALID });
    return z.NEVER;
  }
  return norm;
});

const schoolCreate = z.object({
  code: z.string({ message: INVALID }).optional(),
  name: z.string({ message: INVALID }).min(1, INVALID).max(LIMITS.schoolName, INVALID),
  email_domain: z
    .string({ message: INVALID })
    .transform((v, ctx) => normalizeEmailDomain(v) ?? (ctx.addIssue({ code: 'custom', message: INVALID }), z.NEVER)),
  email_domains: domainArraySchema.optional(),
  student_email_domain: studentDomainSchema.optional(),
  google_domains: domainArraySchema.optional(),
  translations: translationsSchema.optional(),
  region: z.string({ message: INVALID }).min(1, INVALID),
  city: z.string({ message: INVALID }).nullable().optional(),
  requires_verification: z.boolean().optional(),
  allows_student_id_verification: z.boolean().optional(),
});
const schoolUpdate = schoolCreate.partial();

/** Most items one bulk import may carry. */
const BULK_MAX_ITEMS = 500;
/** A bulk item is a single-create body whose region (uppercased, as `?region=` is) and code may be left out or null. */
const schoolBulkItem = schoolCreate.extend({
  region: z
    .string({ message: INVALID })
    .min(1, INVALID)
    .transform((v) => v.trim().toUpperCase())
    .optional(),
  code: z.string({ message: INVALID }).nullable().optional(),
});

async function cityIn(db: Database, regionCode: string, cityCode: string): Promise<number | null> {
  const [row] = await db
    .select({ id: cities.id })
    .from(cities)
    .where(and(eq(cities.regionCode, regionCode), eq(cities.code, cityCode.trim().toUpperCase())))
    .limit(1);
  return row ? row.id : null;
}

schoolRoutes.post('/schools', invalidates('ref'), async (c) => {
  const body = validate(schoolCreate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  // Scope first: every later check (region, codes, domains) reads other regions' data.
  assertInScope(await scopeOf(c), body.region);
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

  const emailDomain = body.email_domain;
  const rawEmailDomains = body.email_domains ?? [];
  const emailDomains = rawEmailDomains.filter((d) => d !== emailDomain);
  const studentEmailDomain = body.student_email_domain ?? '';
  const googleDomains = body.google_domains ?? [];

  if (studentEmailDomain && !isAcceptedDomain(studentEmailDomain, emailDomain, emailDomains)) {
    fieldErrors({ student_email_domain: [INVALID] });
  }
  for (const gd of googleDomains) {
    if (!isAcceptedDomain(gd, emailDomain, emailDomains)) {
      fieldErrors({ google_domains: [INVALID] });
    }
  }

  await assertNoDomainConflicts(db, emailDomain, emailDomains);
  await assertDomainInScope(c, db, emailDomain);
  for (const ed of emailDomains) {
    await assertDomainInScope(c, db, ed);
  }

  if (!code) code = dedupeCode(deriveCode(body.email_domain), taken);
  const [created] = await db
    .insert(schools)
    .values({
      regionCode: body.region,
      code,
      name: body.name,
      emailDomain,
      emailDomains: JSON.stringify(emailDomains),
      studentEmailDomain,
      googleDomains: JSON.stringify(googleDomains),
      translations: JSON.stringify(body.translations ?? {}),
      cityId,
      requiresVerification: body.requires_verification ? 1 : 0,
      allowsStudentIdVerification: body.allows_student_id_verification ? 1 : 0,
      createdAt: new Date().toISOString(),
    })
    .returning({ id: schools.id });
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'admin.school_created',
      meta: {
        school_id: created.id,
        region: body.region,
        code,
        name: body.name,
        email_domain: emailDomain,
        email_domains: emailDomains,
        student_email_domain: studentEmailDomain,
        google_domains: googleDomains,
        requires_verification: body.requires_verification ? true : false,
      },
      targetType: 'school',
      targetId: created.id,
    },
    c,
  );
  const row = await loadSchool(c, created.id);
  return c.json(schoolJson(row, await resolveLanguage(c)), 201);
});

// ---------------------------------------------------------------------------
// Bulk import (before /schools/:id/ so "bulk" is never read as an id)
// ---------------------------------------------------------------------------

schoolRoutes.post('/schools/bulk', invalidates('ref'), async (c) => {
  const body = await readJson(c.req);
  const action = body.action;
  const items = body.items ?? [];
  if (!Array.isArray(items)) apiError(400, INVALID);
  if (items.length > BULK_MAX_ITEMS) apiError(400, 'admin.errTooManyItems', { max: BULK_MAX_ITEMS });
  const currentRegion = regionParam(c);
  if (!currentRegion) apiError(400, 'admin.errMissingRegion');
  assertInScope(await scopeOf(c), currentRegion);

  // Every item passes the single-create rules, and a domain may appear once per file
  // (the unique index would otherwise fail the whole batch with a 500).
  type Parsed = { index: number; item: Record<string, unknown>; data: z.output<typeof schoolBulkItem> };
  const parsed: Parsed[] = [];
  const itemErrors: { index: number; errors: Record<string, string[]> }[] = [];
  const seenDomains = new Set<string>();
  for (const [index, raw] of items.entries()) {
    const result = schoolBulkItem.safeParse(raw);
    if (!result.success) {
      itemErrors.push({ index, errors: describeIssues(result.error, INVALID).fields });
      continue;
    }
    const domain = result.data.email_domain;
    if (seenDomains.has(domain)) {
      itemErrors.push({ index, errors: { email_domain: [INVALID] } });
      continue;
    }
    seenDomains.add(domain);
    const item = raw as Record<string, unknown>;
    item.email_domain = domain;
    parsed.push({ index, item, data: result.data });
  }
  if (itemErrors.length) apiError(400, INVALID, { items: itemErrors });

  const db = createDb(c.env.DB);
  const scope = await scopeOf(c);
  const allSchools = await db.select().from(schools);
  const existingByDomain = new Map(allSchools.map((s) => [s.emailDomain, s]));
  const regionSchools = allSchools.filter((s) => s.regionCode === currentRegion);
  const taken = new Set(regionSchools.map((s) => s.code));
  const codeOwner = new Map(regionSchools.map((s) => [s.code, s.emailDomain]));
  const reserved = new Set(parsed.filter((p) => p.data.code).map((p) => normalizeCode(p.data.code)));
  const regionCities = new Map((await db.select().from(cities).where(eq(cities.regionCode, currentRegion))).map((ct) => [ct.code, ct]));
  const cityCodes = new Map((await db.select({ id: cities.id, code: cities.code }).from(cities)).map((ct) => [ct.id, ct.code]));

  type Planned = {
    item: Record<string, unknown>;
    data: Parsed['data'];
    existing: School | undefined;
    code: string | null;
    cityId: number | null;
    effectiveEmailDomains: string[];
    effectiveStudentDomain: string;
    effectiveGoogleDomains: string[];
    effectiveRequiresVerification: boolean;
    effectiveAllowsStudentIdVerification: boolean;
  };
  const planned: Planned[] = [];
  const forbidden: { index: number }[] = [];
  const badCodes: string[] = [];
  const clashing: string[] = [];
  const badCities: string[] = [];

  for (const { index, item, data } of parsed) {
    const domain = data.email_domain;
    const targetRegion = data.region ?? currentRegion;
    const existing = existingByDomain.get(domain);

    const effectiveEmailDomains =
      data.email_domains !== undefined
        ? data.email_domains.filter((d) => d !== domain)
        : existing
          ? parseJsonArray<string>(existing.emailDomains)
          : [];
    const effectiveStudentDomain =
      data.student_email_domain !== undefined ? data.student_email_domain : existing ? existing.studentEmailDomain : '';
    const effectiveGoogleDomains =
      data.google_domains !== undefined ? data.google_domains : existing ? parseJsonArray<string>(existing.googleDomains) : [];

    if (
      targetRegion !== currentRegion ||
      (existing && existing.regionCode !== currentRegion) ||
      overlapsUnmanaged(scope, domain, allSchools, existing?.id) ||
      effectiveEmailDomains.some((d) => overlapsUnmanaged(scope, d, allSchools, existing?.id))
    ) {
      // By position only: naming the domain would say whether it exists in a region the caller may not manage.
      forbidden.push({ index });
      continue;
    }

    if (effectiveStudentDomain && !isAcceptedDomain(effectiveStudentDomain, domain, effectiveEmailDomains)) {
      itemErrors.push({ index, errors: { student_email_domain: [INVALID] } });
      continue;
    }
    if (effectiveGoogleDomains.some((gd) => !isAcceptedDomain(gd, domain, effectiveEmailDomains))) {
      itemErrors.push({ index, errors: { google_domains: [INVALID] } });
      continue;
    }

    let hasDomainConflict = false;
    for (const other of allSchools) {
      if (other.id === existing?.id) continue;
      const otherExtras = parseJsonArray<string>(other.emailDomains);
      for (const oed of otherExtras) {
        if (domain === oed || domainsOverlap(domain, oed)) {
          itemErrors.push({ index, errors: { email_domain: [domain === oed ? INVALID : DOMAIN_OVERLAP] } });
          hasDomainConflict = true;
          break;
        }
      }
      if (hasDomainConflict) break;
      const otherAccepted = schoolDomains({ email_domain: other.emailDomain, email_domains: other.emailDomains });
      for (const od of otherAccepted) {
        for (const ed of effectiveEmailDomains) {
          if (ed === od || domainsOverlap(ed, od)) {
            itemErrors.push({ index, errors: { email_domains: [ed === od ? INVALID : DOMAIN_OVERLAP] } });
            hasDomainConflict = true;
            break;
          }
        }
        if (hasDomainConflict) break;
      }
      if (hasDomainConflict) break;
    }
    if (hasDomainConflict) continue;

    let cityId: number | null = null;
    if (data.city) {
      const city = regionCities.get(data.city.trim().toUpperCase());
      if (!city) {
        badCities.push(domain);
        continue;
      }
      cityId = city.id;
    }
    let code: string | null = null;
    if (data.code) {
      code = normalizeCode(data.code);
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
    const effectiveRequiresVerification =
      data.requires_verification !== undefined ? !!data.requires_verification : existing ? existing.requiresVerification === 1 : false;
    const effectiveAllowsStudentIdVerification =
      data.allows_student_id_verification !== undefined
        ? !!data.allows_student_id_verification
        : existing
          ? existing.allowsStudentIdVerification === 1
          : false;
    planned.push({
      item,
      data,
      existing,
      code,
      cityId,
      effectiveEmailDomains,
      effectiveStudentDomain,
      effectiveGoogleDomains,
      effectiveRequiresVerification,
      effectiveAllowsStudentIdVerification,
    });
  }

  if (itemErrors.length) apiError(400, INVALID, { items: itemErrors });
  if (badCities.length) apiError(400, 'admin.errSchoolCityUnknown', { domains: badCities });
  if (badCodes.length) apiError(400, 'admin.errSchoolCodeInvalid', { domains: badCodes });
  if (clashing.length) apiError(400, 'admin.errSchoolCodeTaken', { domains: clashing });

  const newItems: unknown[] = [];
  const modified: unknown[] = [];
  const unchanged: unknown[] = [];
  const writes: Parameters<Database['batch']>[0][number][] = [];
  const now = new Date().toISOString();
  const lang = null;
  const modifiedChanges: { school_id: number; email_domain: string; changes: Record<string, { before: unknown; after: unknown }> }[] = [];

  for (const {
    item,
    data,
    existing,
    code,
    cityId,
    effectiveEmailDomains,
    effectiveStudentDomain,
    effectiveGoogleDomains,
    effectiveRequiresVerification,
    effectiveAllowsStudentIdVerification,
  } of planned) {
    const domain = data.email_domain;
    if (!existing) {
      newItems.push({ ...item, code });
      if (action === 'apply') {
        writes.push(
          db.insert(schools).values({
            regionCode: currentRegion,
            code: code!,
            name: data.name,
            emailDomain: domain,
            emailDomains: JSON.stringify(effectiveEmailDomains),
            studentEmailDomain: effectiveStudentDomain,
            googleDomains: JSON.stringify(effectiveGoogleDomains),
            translations: JSON.stringify(data.translations ?? {}),
            cityId,
            requiresVerification: effectiveRequiresVerification ? 1 : 0,
            allowsStudentIdVerification: effectiveAllowsStudentIdVerification ? 1 : 0,
            createdAt: now,
          }),
        );
      }
      continue;
    }
    const oldTranslations = parseJsonObject(existing.translations);
    const newTranslations = data.translations ?? oldTranslations;
    const newCode = code ?? existing.code;
    const newCityId = data.city !== undefined ? cityId : existing.cityId;
    const oldEmailDomains = existing.emailDomains ?? '[]';
    const newEmailDomains = data.email_domains !== undefined ? JSON.stringify(effectiveEmailDomains) : oldEmailDomains;
    const oldStudentDomain = existing.studentEmailDomain ?? '';
    const newStudentDomain = data.student_email_domain !== undefined ? effectiveStudentDomain : oldStudentDomain;
    const oldGoogleDomains = existing.googleDomains ?? '[]';
    const newGoogleDomains = data.google_domains !== undefined ? JSON.stringify(effectiveGoogleDomains) : oldGoogleDomains;
    const oldRequiresVerification = existing.requiresVerification === 1;
    const newRequiresVerification = data.requires_verification !== undefined ? !!data.requires_verification : oldRequiresVerification;
    const oldAllowsStudentIdVerification = existing.allowsStudentIdVerification === 1;
    const newAllowsStudentIdVerification =
      data.allows_student_id_verification !== undefined ? !!data.allows_student_id_verification : oldAllowsStudentIdVerification;

    const changed =
      existing.name !== data.name ||
      JSON.stringify(sortKeys(oldTranslations)) !== JSON.stringify(sortKeys(newTranslations)) ||
      existing.code !== newCode ||
      existing.cityId !== newCityId ||
      oldEmailDomains !== newEmailDomains ||
      oldStudentDomain !== newStudentDomain ||
      oldGoogleDomains !== newGoogleDomains ||
      oldRequiresVerification !== newRequiresVerification ||
      oldAllowsStudentIdVerification !== newAllowsStudentIdVerification;
    if (!changed) {
      unchanged.push(item);
      continue;
    }
    modified.push({
      old: schoolJson({ ...existing, cityCode: existing.cityId ? (cityCodes.get(existing.cityId) ?? null) : null, userCount: 0 }, lang),
      new: item,
    });
    if (action === 'apply') {
      const set = {
        name: data.name,
        translations: JSON.stringify(newTranslations),
        code: newCode,
        cityId: newCityId,
        emailDomains: newEmailDomains,
        studentEmailDomain: newStudentDomain,
        googleDomains: newGoogleDomains,
        requiresVerification: newRequiresVerification ? 1 : 0,
        allowsStudentIdVerification: newAllowsStudentIdVerification ? 1 : 0,
      };
      modifiedChanges.push({ school_id: existing.id, email_domain: domain, changes: changedFields(existing, set) });
      writes.push(db.update(schools).set(set).where(eq(schools.id, existing.id)));
    }
  }

  if (parsed.length > 0 && forbidden.length === parsed.length) apiError(403, 'admin.errAllRegionsForbidden');

  if (writes.length) {
    // Codes were settled for the whole batch above; write it in one go so a
    // failure cannot leave half the file applied. One audit row summarises the import.
    writes.push(
      auditInsert(
        db,
        {
          actorId: c.get('user')!.id,
          kind: 'admin.schools_bulk_applied',
          meta: {
            region: currentRegion,
            created: (newItems as { email_domain: string; code: string }[]).map((i) => ({ email_domain: i.email_domain, code: i.code })),
            modified: modifiedChanges,
          },
          targetType: 'region',
          targetId: currentRegion,
        },
        c,
      ),
    );
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

schoolRoutes.get('/schools/:id', async (c) => {
  const row = await loadSchool(c, intId(c.req.param('id')));
  return c.json(schoolJson(row, await resolveLanguage(c)));
});

schoolRoutes.patch('/schools/:id', invalidates('ref'), async (c) => {
  const instance = await loadSchool(c, intId(c.req.param('id')));
  const body = validate(schoolUpdate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  const region = body.region ?? instance.regionCode;
  // The school's (new or current) region must be managed, checked before any lookup.
  assertInScope(await scopeOf(c), region);
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

  const effectiveEmailDomain = body.email_domain ?? instance.emailDomain;
  const effectiveEmailDomains =
    body.email_domains !== undefined
      ? body.email_domains.filter((d) => d !== effectiveEmailDomain)
      : parseJsonArray<string>(instance.emailDomains);
  const effectiveStudentDomain = body.student_email_domain !== undefined ? body.student_email_domain : instance.studentEmailDomain;
  const effectiveGoogleDomains = body.google_domains !== undefined ? body.google_domains : parseJsonArray<string>(instance.googleDomains);

  if (effectiveStudentDomain && !isAcceptedDomain(effectiveStudentDomain, effectiveEmailDomain, effectiveEmailDomains)) {
    fieldErrors({ student_email_domain: [INVALID] });
  }
  for (const gd of effectiveGoogleDomains) {
    if (!isAcceptedDomain(gd, effectiveEmailDomain, effectiveEmailDomains)) {
      fieldErrors({ google_domains: [INVALID] });
    }
  }

  if (body.email_domain !== undefined || body.email_domains !== undefined) {
    await assertNoDomainConflicts(db, effectiveEmailDomain, effectiveEmailDomains, instance.id);
    if (body.email_domain !== undefined && body.email_domain !== instance.emailDomain) {
      await assertDomainInScope(c, db, body.email_domain, instance.id);
      set.emailDomain = body.email_domain;
    }
    if (body.email_domains !== undefined) {
      for (const ed of effectiveEmailDomains) {
        await assertDomainInScope(c, db, ed, instance.id);
      }
      set.emailDomains = JSON.stringify(effectiveEmailDomains);
    }
  }
  if (body.student_email_domain !== undefined && body.student_email_domain !== instance.studentEmailDomain) {
    set.studentEmailDomain = effectiveStudentDomain;
  }
  if (body.google_domains !== undefined) {
    set.googleDomains = JSON.stringify(effectiveGoogleDomains);
  }

  if (body.name !== undefined) set.name = body.name;
  if (body.translations !== undefined) set.translations = JSON.stringify(body.translations);
  if (body.region !== undefined) set.regionCode = body.region;
  if (body.requires_verification !== undefined) set.requiresVerification = body.requires_verification ? 1 : 0;
  if (body.allows_student_id_verification !== undefined) set.allowsStudentIdVerification = body.allows_student_id_verification ? 1 : 0;

  if (Object.keys(set).length) {
    await db.batch([
      db.update(schools).set(set).where(eq(schools.id, instance.id)),
      auditInsert(
        db,
        {
          actorId: c.get('user')!.id,
          kind: 'admin.school_updated',
          meta: { school_id: instance.id, changes: changedFields(instance, set) },
          targetType: 'school',
          targetId: instance.id,
        },
        c,
      ),
    ]);
  }
  const [row] = await schoolSelect(db).where(eq(schools.id, instance.id)).limit(1);
  return c.json(schoolJson(row, await resolveLanguage(c)));
});

schoolRoutes.delete('/schools/:id', invalidates('ref'), async (c) => {
  const instance = await loadSchool(c, intId(c.req.param('id')));
  // A school with accounts attached cannot be removed: users would silently
  // lose their school. Admins reassign or remove the accounts first.
  if (instance.userCount) apiError(400, 'admin.errDeleteFailed', { count: instance.userCount });
  const db = createDb(c.env.DB);
  await db.batch([
    db.delete(schools).where(eq(schools.id, instance.id)),
    auditInsert(
      db,
      {
        actorId: c.get('user')!.id,
        kind: 'admin.school_deleted',
        meta: {
          school_id: instance.id,
          region: instance.regionCode,
          code: instance.code,
          name: instance.name,
          email_domain: instance.emailDomain,
        },
        targetType: 'school',
        targetId: instance.id,
      },
      c,
    ),
  ]);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// School requests
// ---------------------------------------------------------------------------

const ADMIN_NOTE_MAX_LENGTH = LIMITS.adminNote;
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

schoolRoutes.get('/school-requests', async (c) => {
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

schoolRoutes.get('/school-requests/:id', async (c) => c.json(requestJson(await loadRequest(c, intId(c.req.param('id'))))));

schoolRoutes.patch('/school-requests/:id', invalidates('ref'), async (c) => {
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
