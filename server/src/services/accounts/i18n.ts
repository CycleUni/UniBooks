import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { getRegion } from '../../lib/region';
import { CATALOGS } from './locales';
import { regionDetails } from './regionData';

export const DEFAULT_LANGUAGE = 'en';
/** Languages emails can be written in: one per catalog (core/locales). */
export const EMAIL_LANGUAGES = Object.keys(CATALOGS).sort();
export const EMAIL_LANGUAGE_AUTO = 'auto';

/** The string for `key` in `lang`, `{name}` placeholders filled in; falls back to English. */
export function t(lang: string | null | undefined, key: string, params?: Record<string, string | number>): string {
  const catalog = CATALOGS[lang ?? ''] ?? CATALOGS[String(lang ?? '').split('-')[0]] ?? CATALOGS[DEFAULT_LANGUAGE];
  const template = catalog[key] ?? CATALOGS[DEFAULT_LANGUAGE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Normalize a language tag to a supported code. */
export function normalizeLanguage(raw: string | null | undefined, regionDefault?: string | null): string {
  if (!raw) return DEFAULT_LANGUAGE;
  const lang = raw.trim().replace(/_/g, '-');
  if (!lang) return DEFAULT_LANGUAGE;
  const lower = lang.toLowerCase();
  if (['zh-hk', 'zh-hant-hk', 'yue', 'zh-yue'].includes(lower)) return 'zh-HK';
  if (['zh-cn', 'zh-hans'].includes(lower)) return regionDefault || 'zh-TW';
  if (['zh-tw', 'zh-hant-tw', 'zh-hant', 'zh'].includes(lower)) {
    return regionDefault && regionDefault.startsWith('zh') ? regionDefault : 'zh-TW';
  }
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return lang;
}

/** The language a request asks for: ?lang= wins, then the first Accept-Language tag ('' when neither is given). */
export function requestedLanguage(c: Context<AppEnv>): string {
  const lang = (c.req.query('lang') ?? '').trim();
  if (lang) return lang;
  return (c.req.header('Accept-Language') ?? '').split(',')[0].split(';')[0].trim();
}

/**
 * Settle a requested language against a region: none requested gives the region's default; otherwise the tag is normalized
 * and anything the region does not offer becomes its default. With no region (`defaultLanguage` null) the tag is only normalized.
 */
export function pickLanguage(requested: string, defaultLanguage: string | null, supported: string[] | null): string {
  if (!requested) return defaultLanguage ?? DEFAULT_LANGUAGE;
  const normalized = normalizeLanguage(requested, defaultLanguage);
  if (defaultLanguage !== null && supported && !supported.includes(normalized)) return defaultLanguage;
  return normalized;
}

/**
 * The request's language: ?lang= wins, then the first
 * Accept-Language tag, then the region's default; anything the region does
 * not offer becomes the region's default.
 */
export async function resolveLanguage(c: Context<AppEnv>): Promise<string> {
  const region = await getRegion(c);
  const details = region ? await regionDetails(c.env, region.code) : null;
  return pickLanguage(requestedLanguage(c), details?.defaultLanguage ?? null, details?.languages ?? null);
}

/**
 * The user's chosen language (unless 'auto'), else the language last used on the site, else the region's default, taking the
 * first that is in `allowed`; `fallback` when none is.
 */
export function pickUserLanguage<L extends string>(
  user: { emailLanguage?: string | null; siteLanguage?: string | null },
  regionDefaultLanguage: string | null | undefined,
  allowed: readonly L[],
  fallback: L,
): L {
  for (const candidate of [
    user.emailLanguage === EMAIL_LANGUAGE_AUTO ? null : user.emailLanguage,
    user.siteLanguage,
    regionDefaultLanguage,
  ]) {
    if (candidate && (allowed as readonly string[]).includes(candidate)) return candidate as L;
  }
  return fallback;
}

/** The language emails to this user are written in. */
export function emailLanguageFor(
  user: { emailLanguage?: string | null; siteLanguage?: string | null },
  regionDefaultLanguage?: string | null,
): string {
  return pickUserLanguage(user, regionDefaultLanguage, EMAIL_LANGUAGES, DEFAULT_LANGUAGE);
}
