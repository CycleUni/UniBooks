/**
 * `?school=` resolution and localized names.
 *
 * Schools, cities and categories belong to other modules; rows are read whole
 * and optional columns (translations, code, slug, region) are read defensively
 * so this keeps working while those tables evolve.
 */
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppEnv, Env } from '../../env';
import { createDb, schools, cities, categories, type Region } from '../../db';
import { parseJson, stringList } from '../../lib/json';
import { normalizeCode } from '../admin/schoolCodes';
import { pickLanguage, requestedLanguage } from '../accounts/i18n';
import { pickTranslation } from '../accounts/regionData';

type Row = Record<string, unknown>;

/** No school has id 0: filtering on it matches nothing (an unknown ?school=). */
export const NO_SCHOOL_ID = 0;

export interface PlaceScope {
  /** null: no filter; NO_SCHOOL_ID: named no school; else the school id. */
  schoolId: number | null;
  /** The chosen school's city (id + code), when it has one. */
  city: { id: number; code: string | null } | null;
}

/** The school a `?school=` names, searched only inside the region: code first, then exact name. */
export async function resolveSchool(env: Env, region: Region | null, value: string): Promise<Row | null> {
  if (!value || !region) return null;
  const rows = (await createDb(env.DB).select().from(schools).where(eq(schools.regionCode, region.code))) as Row[];
  const code = normalizeCode(value);
  if (code && code.length <= 20 && /^[A-Z0-9-]+$/.test(code)) {
    const hit = rows.find((s) => typeof s.code === 'string' && s.code.toUpperCase() === code);
    if (hit) return hit;
  }
  return rows.find((s) => s.name === value) ?? null;
}

export async function schoolFilterScope(env: Env, region: Region | null, value: string | undefined): Promise<PlaceScope> {
  if (!value) return { schoolId: null, city: null };
  const school = await resolveSchool(env, region, value);
  if (!school) return { schoolId: NO_SCHOOL_ID, city: null };
  const cityId = typeof school.cityId === 'number' ? school.cityId : null;
  if (cityId === null) return { schoolId: Number(school.id), city: null };
  const [city] = (await createDb(env.DB).select().from(cities).where(eq(cities.id, cityId)).limit(1)) as Row[];
  return {
    schoolId: Number(school.id),
    city: city ? { id: cityId, code: typeof city.code === 'string' ? city.code : null } : null,
  };
}

export async function schoolFilterId(env: Env, region: Region | null, value: string | undefined): Promise<number | null> {
  return (await schoolFilterScope(env, region, value)).schoolId;
}

/** ?lang= → Accept-Language → the region's default language; a language the region does not offer becomes its default. */
export function resolveLanguage(c: Context<AppEnv>, region: Region | null): string {
  return pickLanguage(requestedLanguage(c), region?.defaultLanguage ?? null, region ? stringList(region.languages) : null);
}

export function localizedSchoolName(school: Row, lang: string | null): string {
  const name = typeof school.name === 'string' ? school.name : '';
  if (!lang) return name;
  const t = pickTranslation(school.translations, lang).name;
  return typeof t === 'string' && t ? t : name;
}

export interface CategoryRef {
  id: number;
  slug: string;
}

function categorySlug(row: Row): string {
  return String(row.slug ?? row.code ?? '');
}

/** Active categories of a region (rows without a region column count for every region). */
export async function regionCategories(env: Env, regionCode: string): Promise<Array<CategoryRef & { row: Row }>> {
  const rows = (await createDb(env.DB).select().from(categories)) as Row[];
  return rows
    .filter((r) => r.regionCode === undefined || r.regionCode === regionCode)
    .map((r) => ({ id: Number(r.id), slug: categorySlug(r), row: r }));
}

/** A category slug resolved inside the listing's region (slugs repeat across regions). */
export async function resolveCategorySlug(env: Env, regionCode: string, slug: string): Promise<CategoryRef | null> {
  const hit = (await regionCategories(env, regionCode)).find(
    (c) => c.slug === slug && (c.row.isActive === undefined || Number(c.row.isActive) === 1),
  );
  return hit ? { id: hit.id, slug: hit.slug } : null;
}

/** id → slug for every category (for serializing listings). */
export async function categorySlugsById(env: Env, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = (await createDb(env.DB).select().from(categories)) as Row[];
  return new Map(rows.filter((r) => ids.includes(Number(r.id))).map((r) => [Number(r.id), categorySlug(r)]));
}

/** Category ids whose slug, title or any translated title contains `q` (case-insensitive). */
export async function categoryIdsMatchingText(env: Env, regionCode: string, q: string): Promise<number[]> {
  const needle = q.toLowerCase();
  const out: number[] = [];
  for (const c of await regionCategories(env, regionCode)) {
    const titles = [c.row.title, c.row.name];
    const t = parseJson<unknown>(c.row.translations, null);
    if (t && typeof t === 'object') {
      for (const v of Object.values(t as Record<string, unknown>)) {
        if (v && typeof v === 'object') titles.push((v as Row).title, (v as Row).name);
      }
    }
    if (titles.some((x) => typeof x === 'string' && x.toLowerCase().includes(needle))) out.push(c.id);
  }
  return out;
}
