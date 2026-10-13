import { Hono } from 'hono';
import { inList } from '../../lib/sql';
import type { Context } from 'hono';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { createDb, currencies, languages, regions, type Currency, type Region } from '../../db';
import { requireSuperuser } from '../../middleware/auth';
import { fieldErrors, pagination, readJson, validate } from '../../lib/http';
import { invalidateRegionCache } from '../../lib/region';
import { parseJsonArray, parseJsonObject } from '../../lib/json';
import { localized, resolveLanguage } from '../../services/admin/i18n';
import { notFound, regionExists } from '../../services/admin/scope';
import { seedDefaultCategories } from '../../services/admin/defaults';

/**
 * Regions and currencies, superuser only.
 */
export const regionRoutes = new Hono<AppEnv>();

regionRoutes.use('/regions/*', requireSuperuser());
regionRoutes.use('/currencies/*', requireSuperuser());

const INVALID = 'admin.errInvalidField';

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

export function currencyJson(c: Currency) {
  return {
    code: c.code,
    symbol: c.symbol,
    decimal_places: c.decimalPlaces,
    symbol_position: c.symbolPosition,
    is_active: !!c.isActive,
  };
}

const currencyCreate = z.object({
  code: z.string().min(1, INVALID).max(3, INVALID),
  symbol: z.string().min(1, INVALID).max(8, INVALID),
  decimal_places: z.number({ message: INVALID }).int(INVALID).min(0, INVALID).max(32767, INVALID).optional(),
  symbol_position: z.enum(['prefix', 'suffix'], { message: INVALID }).optional(),
  is_active: z.boolean({ message: INVALID }).optional(),
});

regionRoutes.get('/currencies/', async (c) => {
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url);
  const [{ n }] = await db.select({ n: count() }).from(currencies);
  const rows = await db.select().from(currencies).orderBy(asc(currencies.code)).limit(page.limit).offset(page.offset);
  return c.json(page.wrap(rows.map(currencyJson), n));
});

regionRoutes.post('/currencies/', async (c) => {
  const body = validate(currencyCreate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  const [exists] = await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.code, body.code)).limit(1);
  if (exists) fieldErrors({ code: [INVALID] });
  const [row] = await db
    .insert(currencies)
    .values({
      code: body.code,
      symbol: body.symbol,
      decimalPlaces: body.decimal_places ?? 2,
      symbolPosition: body.symbol_position ?? 'prefix',
      isActive: body.is_active === false ? 0 : 1,
    })
    .returning();
  invalidateRegionCache();
  return c.json(currencyJson(row), 201);
});

async function getCurrency(c: Context<AppEnv>): Promise<Currency> {
  const [row] = await createDb(c.env.DB)
    .select()
    .from(currencies)
    .where(eq(currencies.code, c.req.param('code')!))
    .limit(1);
  if (!row) notFound();
  return row;
}

regionRoutes.get('/currencies/:code/', async (c) => c.json(currencyJson(await getCurrency(c))));

const currencyUpdate = currencyCreate.partial();

async function updateCurrency(c: Context<AppEnv>) {
  const instance = await getCurrency(c);
  const body = validate(currencyUpdate, await readJson(c.req), INVALID);
  // Rejected, not dropped: amounts are stored in minor units, so a changed
  // decimal_places would reinterpret every price at once.
  if (body.decimal_places !== undefined && body.decimal_places !== instance.decimalPlaces) {
    fieldErrors({ decimal_places: ['admin.errCurrencyDecimalPlacesLocked'] });
  }
  if (body.code !== undefined && body.code !== instance.code) {
    fieldErrors({ code: ['admin.errCurrencyCodeLocked'] });
  }
  const set: Partial<Currency> = {};
  if (body.symbol !== undefined) set.symbol = body.symbol;
  if (body.symbol_position !== undefined) set.symbolPosition = body.symbol_position;
  if (body.is_active !== undefined) set.isActive = body.is_active ? 1 : 0;
  const db = createDb(c.env.DB);
  let row = instance;
  if (Object.keys(set).length) {
    [row] = await db.update(currencies).set(set).where(eq(currencies.code, instance.code)).returning();
    invalidateRegionCache();
  }
  return c.json(currencyJson(row));
}

regionRoutes.patch('/currencies/:code/', updateCurrency);
regionRoutes.put('/currencies/:code/', updateCurrency);

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export function regionJson(r: Region, lang: string | null) {
  return {
    code: r.code,
    name: r.name,
    display_name: lang ? localized(r.translations, lang, 'name', r.name) : r.name,
    translations: parseJsonObject(r.translations),
    currency: r.defaultCurrency,
    default_language: r.defaultLanguage,
    languages: parseJsonArray<string>(r.languages),
    timezone: r.timezone,
    search_engines: parseJsonArray<string>(r.searchEngines),
    edu_email_suffix: parseJsonArray<string>(r.eduEmailSuffix),
    is_active: !!r.isActive,
    sort_order: r.sortOrder,
  };
}

const strList = z.array(z.string({ message: INVALID }), { message: INVALID });
const translationsSchema = z.record(z.string(), z.unknown(), { message: INVALID });

const regionFields = {
  name: z.string().min(1, INVALID).max(100, INVALID),
  translations: translationsSchema,
  currency: z.string({ message: INVALID }),
  default_language: z.string({ message: INVALID }),
  languages: strList,
  timezone: z.string().min(1, INVALID).max(64, INVALID),
  search_engines: strList,
  edu_email_suffix: strList,
  is_active: z.boolean({ message: INVALID }),
  sort_order: z.number({ message: INVALID }).int(INVALID).min(0, INVALID),
};

const regionCreate = z.object({
  code: z.string().min(1, INVALID).max(2, INVALID),
  ...regionFields,
  timezone: regionFields.timezone.optional(),
  search_engines: regionFields.search_engines.optional(),
  edu_email_suffix: regionFields.edu_email_suffix.optional(),
  is_active: regionFields.is_active.optional(),
  sort_order: regionFields.sort_order.optional(),
  translations: regionFields.translations.optional(),
  languages: regionFields.languages.optional(),
});

const regionUpdate = z.object(regionFields).partial().extend({ code: z.unknown().optional() });

/** Reference checks for the foreign keys in the body. */
async function checkRefs(c: Context<AppEnv>, body: { currency?: string; default_language?: string; languages?: string[] }) {
  const db = createDb(c.env.DB);
  const errors: Record<string, string[]> = {};
  if (body.currency !== undefined) {
    const [cur] = await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.code, body.currency)).limit(1);
    if (!cur) errors.currency = [INVALID];
  }
  const langCodes = [...new Set([...(body.languages ?? []), ...(body.default_language ? [body.default_language] : [])])];
  if (langCodes.length) {
    const found = new Set(
      (await db.select({ code: languages.code }).from(languages).where(inList(languages.code, langCodes))).map((l) => l.code),
    );
    if (body.default_language !== undefined && !found.has(body.default_language)) errors.default_language = [INVALID];
    if (body.languages?.some((l) => !found.has(l))) errors.languages = [INVALID];
  }
  if (Object.keys(errors).length) fieldErrors(errors);
}

regionRoutes.get('/regions/', async (c) => {
  const db = createDb(c.env.DB);
  const lang = await resolveLanguage(c);
  const page = pagination(c.req.url);
  const [{ n }] = await db.select({ n: count() }).from(regions);
  const rows = await db.select().from(regions).orderBy(asc(regions.sortOrder), asc(regions.code)).limit(page.limit).offset(page.offset);
  return c.json(
    page.wrap(
      rows.map((r) => regionJson(r, lang)),
      n,
    ),
  );
});

regionRoutes.post('/regions/', async (c) => {
  const body = validate(regionCreate, await readJson(c.req), INVALID);
  await checkRefs(c, body);
  if (!body.translations || !Object.keys(body.translations).length) {
    fieldErrors({ translations: ['admin.errTranslationsRequired'] });
  }
  if (!body.languages || !body.languages.length) fieldErrors({ languages: ['admin.errLanguagesRequired'] });
  if (!body.languages.includes(body.default_language)) {
    fieldErrors({ default_language: ['admin.errDefaultLanguageNotSupported'] });
  }
  const db = createDb(c.env.DB);
  if (await regionExists(db, body.code)) fieldErrors({ code: [INVALID] });
  const [row] = await db
    .insert(regions)
    .values({
      code: body.code,
      name: body.name,
      translations: JSON.stringify(body.translations),
      defaultCurrency: body.currency,
      defaultLanguage: body.default_language,
      languages: JSON.stringify(body.languages),
      timezone: body.timezone ?? 'Asia/Taipei',
      searchEngines: JSON.stringify(body.search_engines ?? []),
      eduEmailSuffix: JSON.stringify(body.edu_email_suffix ?? []),
      isActive: body.is_active === false ? 0 : 1,
      sortOrder: body.sort_order ?? 0,
      createdAt: new Date().toISOString(),
    })
    .returning();
  // A new region starts with the default colleges, not an empty category rail.
  await seedDefaultCategories(db, row.code);
  invalidateRegionCache();
  return c.json(regionJson(row, await resolveLanguage(c)), 201);
});

async function getRegionRow(c: Context<AppEnv>): Promise<Region> {
  const [row] = await createDb(c.env.DB)
    .select()
    .from(regions)
    .where(eq(regions.code, c.req.param('code')!))
    .limit(1);
  if (!row) notFound();
  return row;
}

regionRoutes.get('/regions/:code/', async (c) => c.json(regionJson(await getRegionRow(c), await resolveLanguage(c))));

async function updateRegion(c: Context<AppEnv>) {
  const instance = await getRegionRow(c);
  const body = validate(regionUpdate, await readJson(c.req), INVALID);
  await checkRefs(c, body);

  const defaultLang = body.default_language ?? instance.defaultLanguage;
  const langs = body.languages ?? parseJsonArray<string>(instance.languages);
  if (!langs.includes(defaultLang)) fieldErrors({ default_language: ['admin.errDefaultLanguageNotSupported'] });
  if (body.translations !== undefined && !Object.keys(body.translations).length) {
    fieldErrors({ translations: ['admin.errTranslationsRequired'] });
  }

  const db = createDb(c.env.DB);
  if (body.is_active === false && instance.isActive) {
    const [{ n }] = await db
      .select({ n: count() })
      .from(regions)
      .where(and(eq(regions.isActive, 1), ne(regions.code, instance.code)));
    if (n === 0) fieldErrors({ is_active: ['admin.errCannotDisableLastRegion'] });
  }

  const set: Partial<Region> = {};
  if (body.name !== undefined) set.name = body.name;
  if (body.translations !== undefined) set.translations = JSON.stringify(body.translations);
  if (body.currency !== undefined) set.defaultCurrency = body.currency;
  if (body.default_language !== undefined) set.defaultLanguage = body.default_language;
  if (body.languages !== undefined) set.languages = JSON.stringify(body.languages);
  if (body.timezone !== undefined) set.timezone = body.timezone;
  if (body.search_engines !== undefined) set.searchEngines = JSON.stringify(body.search_engines);
  if (body.edu_email_suffix !== undefined) set.eduEmailSuffix = JSON.stringify(body.edu_email_suffix);
  if (body.is_active !== undefined) set.isActive = body.is_active ? 1 : 0;
  if (body.sort_order !== undefined) set.sortOrder = body.sort_order;

  let row = instance;
  if (Object.keys(set).length) {
    [row] = await db.update(regions).set(set).where(eq(regions.code, instance.code)).returning();
    if (set.isActive === 0) {
      // Re-checked after the write: two admins disabling the last two
      // regions at once must not both succeed.
      const [{ n }] = await db.select({ n: count() }).from(regions).where(eq(regions.isActive, 1));
      if (n === 0) {
        await db.update(regions).set({ isActive: 1 }).where(eq(regions.code, instance.code));
        invalidateRegionCache();
        fieldErrors({ is_active: ['admin.errCannotDisableLastRegion'] });
      }
    }
    invalidateRegionCache();
  }
  return c.json(regionJson(row, await resolveLanguage(c)));
}

regionRoutes.patch('/regions/:code/', updateRegion);
regionRoutes.put('/regions/:code/', updateRegion);
