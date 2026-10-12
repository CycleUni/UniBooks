import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import type { Region } from '../../db';
import { getRegion } from '../../lib/region';

/**
 * Language resolution, normalization and translation picking. Model rows store canonical English in their plain fields
 * and localized values in a `translations` JSON column.
 */

export const DEFAULT_LANGUAGE = 'en';

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function normalizeLanguage(lang: string | null | undefined, region?: Region | null): string {
  if (!lang) return DEFAULT_LANGUAGE;
  const l = lang.trim().replace(/_/g, '-');
  if (!l) return DEFAULT_LANGUAGE;
  const lower = l.toLowerCase();
  if (['zh-hk', 'zh-hant-hk', 'yue', 'zh-yue'].includes(lower)) return 'zh-HK';
  if (['zh-cn', 'zh-hans'].includes(lower)) return region?.defaultLanguage || 'zh-TW';
  if (['zh-tw', 'zh-hant-tw', 'zh-hant', 'zh'].includes(lower)) {
    return region?.defaultLanguage?.startsWith('zh') ? region.defaultLanguage : 'zh-TW';
  }
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return l;
}

/** ?lang= wins, then Accept-Language, then the region's default language. */
export async function resolveLanguage(c: Context<AppEnv>): Promise<string> {
  let lang = (c.req.query('lang') ?? '').trim();
  if (!lang) {
    const accept = c.req.header('Accept-Language') ?? '';
    lang = accept.split(',')[0].split(';')[0].trim();
  }
  const region = await getRegion(c);
  if (!lang) return region?.defaultLanguage ?? DEFAULT_LANGUAGE;
  const normalized = normalizeLanguage(lang, region);
  if (region) {
    const supported = parseJsonArray<string>(region.languages);
    if (!supported.includes(normalized)) return region.defaultLanguage;
  }
  return normalized;
}

/** The translation dict for `lang` (exact tag, then base language), or {}. */
export function pickTranslation(translations: unknown, lang: string | null | undefined): Record<string, unknown> {
  if (!translations || typeof translations !== 'object' || Array.isArray(translations) || !lang) return {};
  const t = translations as Record<string, unknown>;
  const exact = t[lang];
  if (exact && typeof exact === 'object' && !Array.isArray(exact)) return exact as Record<string, unknown>;
  const base = lang.split('-')[0];
  for (const [key, value] of Object.entries(t)) {
    if (key.split('-')[0] === base && value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return {};
}

/** A localized field with fallback to the canonical value. */
export function localized(translationsJson: string | null | undefined, lang: string | null, field: string, fallback: string): string {
  const v = pickTranslation(parseJsonObject(translationsJson), lang)[field];
  return typeof v === 'string' && v ? v : fallback;
}
