import { Hono, type Context } from 'hono';
import { cached } from '../lib/cache';
import type { Region } from '../db';
import { rateLimit } from '../middleware/rateLimit';
import { and, asc, count, desc, eq, exists, getTableName, is, isNotNull } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { AppEnv } from '../env';
import {
  books,
  categories,
  cities,
  createDb,
  currencies as currenciesTable,
  regionVerifications,
  schema,
  schools,
  subscriptions,
} from '../db';
import { activeRegions, requireRegion } from '../lib/region';
import { optionalAuthMiddleware } from '../middleware/auth';
import { resolveLanguage } from '../services/accounts/i18n';
import { activeRegionDetails, localizedName, pickTranslation, type Row } from '../services/accounts/regionData';
import { resolveSchool } from '../services/listings/places';
import { parseJson } from '../lib/json';

/**
 * /api/v1/core/*: health check, regions, geo region and home metadata
 * (/api/v1/core/metadata/).
 */
export const coreRoutes = new Hono<AppEnv>();

/** Every table the schema declares; a deploy whose migrations are behind lacks some. */
const SCHEMA_TABLES = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable)).map((t) => getTableName(t));

// Unauthenticated and touches D1 + KV: throttle it like any other public probe.
coreRoutes.get('/healthz', rateLimit('healthz', '30/min'), async (c) => {
  // Raw: probes of D1 itself, not of a schema table.
  let dbOk = false;
  try {
    const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    dbOk = row?.ok === 1;
  } catch (e) {
    console.error('[healthz] database failure', e);
  }

  // KV is the cache. Read-only: this probe is unauthenticated
  // and unthrottled, and a write per hit would spend KV's write budget.
  let cacheOk = false;
  try {
    await c.env.KV.get('healthz_probe');
    cacheOk = true;
  } catch (e) {
    console.error('[healthz] cache failure', e);
  }

  let migrationsOk = false;
  let unapplied: number | null = null;
  try {
    const { results } = await c.env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const present = new Set(results.map((r) => r.name));
    unapplied = SCHEMA_TABLES.filter((name) => !present.has(name)).length;
    migrationsOk = unapplied === 0;
  } catch (e) {
    console.error('[healthz] migrations check failure', e);
    unapplied = null;
  }

  const healthy = dbOk && cacheOk && migrationsOk;
  return c.json(
    {
      status: healthy ? 'healthy' : 'unhealthy',
      checks: {
        database: dbOk ? 'ok' : 'error',
        cache: cacheOk ? 'ok' : 'error',
        migrations: migrationsOk ? 'ok' : 'error',
      },
      unapplied_migrations: unapplied,
    },
    healthy ? 200 : 503,
  );
});

coreRoutes.get('/regions', async (c) => {
  const lang = await resolveLanguage(c);
  // Same for every visitor; admin region/currency edits invalidate 'ref'.
  const body = await cached(c.env, 'ref', `regions:${lang}`, 3600, async () => {
    const regions = await activeRegionDetails(c.env);
    const currencies = await createDb(c.env.DB).select().from(currenciesTable);
    const byCode = new Map(currencies.map((cur) => [cur.code, cur]));
    return regions.map((r) => {
      const cur = byCode.get(r.currencyCode);
      return {
        code: r.code,
        name: r.name,
        localized_name: pickTranslation(r.translations, lang).name || r.name,
        // An object: the frontend formats prices with decimal_places.
        currency: {
          code: r.currencyCode,
          symbol: String(cur?.symbol ?? ''),
          decimal_places: Number(cur?.decimalPlaces ?? 2),
          symbol_position: String(cur?.symbolPosition ?? 'prefix'),
        },
        languages: r.languages,
        default_language: r.defaultLanguage,
        timezone: r.timezone,
        search_engines: r.searchEngines,
        edu_email_suffix: r.eduEmailSuffix,
      };
    });
  });
  // Viewer-independent: let browsers and the service worker reuse it.
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Vary', 'Accept-Language, X-Region, Cookie');
  return c.json(body);
});

coreRoutes.get('/geo', async (c) => {
  // Only the CDN's country header: ?region=/X-Region/cookie would just echo
  // back what the frontend already sent.
  const country = (c.req.header('CF-IPCountry') ?? '').trim().toUpperCase();
  let region: string | null = null;
  if (country) {
    try {
      if ((await activeRegions(c.env)).has(country)) region = country;
    } catch (e) {
      console.error('[geo] failed to load active regions', e);
    }
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ region });
});

/** The canonical name and every localized one, without repeats. */
function allNames(row: Row): string[] {
  const names = [String(row.name ?? '')];
  const translations = parseJson<unknown>(row.translations, {});
  if (translations && typeof translations === 'object' && !Array.isArray(translations)) {
    for (const fields of Object.values(translations as Record<string, unknown>)) {
      const name = fields && typeof fields === 'object' ? (fields as Record<string, unknown>).name : null;
      if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

coreRoutes.get('/metadata', rateLimit('metadata', '120/min'), optionalAuthMiddleware(), async (c) => {
  const [lang, region] = await Promise.all([resolveLanguage(c), requireRegion(c)]);
  const schoolParam = c.req.query('school') ?? '';
  // The key holds only validated values (a school id, or one shared marker
  // for "names no school"), so arbitrary ?school= values cannot each mint a
  // KV entry. Reference rows invalidate 'ref' on admin edits; the waitlist
  // counts may lag 5 minutes.
  const school = schoolParam ? await resolveSchool(c.env, region, schoolParam) : null;
  const schoolKey = school ? String(school.id) : schoolParam ? 'unknown' : '';
  const body = await cached(c.env, 'ref', `metadata:${region.code}:${lang}:${schoolKey}`, 300, () =>
    buildMetadata(c, region, lang, schoolParam),
  );
  // Viewer-independent: let browsers and the service worker reuse it.
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Vary', 'Accept-Language, X-Region, Cookie');
  return c.json(body);
});

async function buildMetadata(c: Context<AppEnv>, region: Region, lang: string, schoolParam: string) {
  const db = createDb(c.env.DB);

  const [schoolRows, cityRows, categoryRows] = await Promise.all([
    db
      .select({
        id: schools.id,
        code: schools.code,
        name: schools.name,
        translations: schools.translations,
        emailDomain: schools.emailDomain,
        cityCode: cities.code,
      })
      .from(schools)
      .leftJoin(cities, eq(cities.id, schools.cityId))
      .where(and(eq(schools.regionCode, region.code), eq(schools.isActive, 1)))
      .orderBy(asc(schools.id)),
    db.select().from(cities).where(eq(cities.regionCode, region.code)).orderBy(asc(cities.sortOrder), asc(cities.code)),
    db
      .select()
      .from(categories)
      .where(and(eq(categories.regionCode, region.code), eq(categories.isActive, 1)))
      .orderBy(asc(categories.sortOrder), asc(categories.id)),
  ]);

  const schoolList = schoolRows.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    display_name: localizedName(s, lang),
    names: allNames(s),
    email_domain: s.emailDomain,
    city: s.cityCode ?? null,
  }));
  const cityList = cityRows.map((ci) => ({ code: ci.code, name: ci.name, display_name: localizedName(ci, lang) }));
  const categoryList = categoryRows.map((cat) => {
    const t = pickTranslation(cat.translations, lang);
    return { slug: cat.slug, title: t.title || cat.title, desc: t.description || cat.description };
  });

  // Most wanted. A ?school= that names no school here means an empty list,
  // never "every school".
  let waitlist: { title: unknown; count: number; book_id: unknown; cover_url: unknown; isbn: unknown; authors: unknown }[] = [];
  const school = schoolParam ? await resolveSchool(c.env, region, schoolParam) : null;
  if (!schoolParam || school) {
    const bySchool = school
      ? exists(
          db
            .select({ id: regionVerifications.id })
            .from(regionVerifications)
            .where(
              and(
                eq(regionVerifications.userId, subscriptions.userId),
                eq(regionVerifications.regionCode, subscriptions.regionCode),
                eq(regionVerifications.schoolId, Number(school.id)),
                eq(regionVerifications.isActive, 1),
                isNotNull(regionVerifications.verifiedAt),
              ),
            ),
        )
      : undefined;
    const n = count(subscriptions.userId);
    const results = await db
      .select({
        bookId: subscriptions.bookId,
        title: books.title,
        coverUrl: books.coverUrl,
        isbn13: books.isbn13,
        authors: books.authors,
        n,
      })
      .from(subscriptions)
      .innerJoin(books, eq(books.id, subscriptions.bookId))
      .where(and(eq(subscriptions.regionCode, region.code), bySchool))
      .groupBy(subscriptions.bookId, books.title, books.coverUrl, books.isbn13, books.authors)
      .orderBy(desc(n))
      .limit(7);
    waitlist = results.map((r) => ({
      title: r.title,
      count: Number(r.n),
      book_id: r.bookId,
      cover_url: r.coverUrl,
      isbn: r.isbn13,
      authors: r.authors,
    }));
  }

  return {
    lang,
    region: { code: region.code, currency: region.defaultCurrency },
    schools: schoolList,
    cities: cityList,
    categories: categoryList,
    waitlist,
  };
}
