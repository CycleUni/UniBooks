import type { Env } from '../../env';
import { parseJson, stringList } from '../../lib/json';

/**
 * Read-only views of the reference tables other modules own (regions,
 * currencies, schools, cities, categories), read with `SELECT *` so the
 * fields those owners add (translations, edu_email_suffix,
 * search_engines, symbol_position, sort_order, ...) are picked up when they
 * exist and fall back to sensible values while they do not.
 */

export type Row = Record<string, unknown>;

/** The translation dict for `lang` (exact tag, then same base language), or {}. Takes a JSON string or the parsed object. */
export function pickTranslation(translations: unknown, lang: string | null | undefined): Record<string, string> {
  const t = parseJson<unknown>(translations, {});
  if (!t || typeof t !== 'object' || Array.isArray(t) || !lang) return {};
  const map = t as Record<string, unknown>;
  const exact = map[lang];
  if (exact && typeof exact === 'object' && !Array.isArray(exact)) return exact as Record<string, string>;
  const base = lang.split('-')[0];
  for (const [key, value] of Object.entries(map)) {
    if (key.split('-')[0] === base && value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, string>;
  }
  return {};
}

export function localizedName(row: Row, lang: string): string {
  return pickTranslation(row.translations, lang).name || String(row.name ?? '');
}

export interface RegionDetails {
  code: string;
  name: string;
  translations: unknown;
  defaultLanguage: string;
  currencyCode: string;
  languages: string[];
  timezone: string;
  searchEngines: string[];
  eduEmailSuffix: string[];
  sortOrder: number;
  isActive: boolean;
}

function toRegion(row: Row): RegionDetails {
  const defaultLanguage = String(row.default_language ?? row.default_language_id ?? 'en');
  const languages = stringList(row.languages);
  return {
    code: String(row.code).toUpperCase(),
    name: String(row.name ?? row.code),
    translations: row.translations,
    defaultLanguage,
    currencyCode: String(row.default_currency ?? row.currency ?? row.currency_code ?? ''),
    // Until the owner adds a languages column: the region default plus English.
    languages: languages.length ? languages : Array.from(new Set([defaultLanguage, 'en'])),
    timezone: String(row.timezone ?? 'Asia/Taipei'),
    searchEngines: stringList(row.search_engines),
    eduEmailSuffix: stringList(row.edu_email_suffix),
    sortOrder: Number(row.sort_order ?? 0) || 0,
    isActive: Number(row.is_active ?? 1) === 1,
  };
}

const TTL_MS = 60_000;
let cache: { at: number; rows: RegionDetails[] } | null = null;

/** Active regions in display order (sort_order, code). Cached per isolate for a minute. */
export async function activeRegionDetails(env: Env): Promise<RegionDetails[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const { results } = await env.DB.prepare('SELECT * FROM regions WHERE is_active = 1').all<Row>();
  const rows = results.map(toRegion).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  cache = { at: Date.now(), rows };
  return rows;
}

export async function regionDetails(env: Env, code: string | null | undefined): Promise<RegionDetails | null> {
  if (!code) return null;
  const upper = code.toUpperCase();
  const hit = (await activeRegionDetails(env)).find((r) => r.code === upper);
  if (hit) return hit;
  const row = await env.DB.prepare('SELECT * FROM regions WHERE code = ?').bind(upper).first<Row>();
  return row ? toRegion(row) : null;
}

/** Test seam: drop the isolate's region cache. */
export function resetRegionDetailsCache() {
  cache = null;
}

/** The domains a school row accepts: the email_domain column, or the email_domains list. */
export function schoolDomains(row: Row): string[] {
  const list = stringList(row.email_domains);
  if (typeof row.email_domain === 'string' && row.email_domain) list.unshift(row.email_domain);
  return list.map((d) => d.toLowerCase().replace(/^@/, ''));
}
