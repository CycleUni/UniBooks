export type Lang = 'en' | 'zh-TW' | 'zh-HK';

export const SUPPORTED_LANGS: readonly Lang[] = ['en', 'zh-TW', 'zh-HK'];

/** Maps URL region prefixes to their corresponding language. */
export const REGION_TO_LANG: Record<string, Lang> = {
 tw: 'zh-TW',
 hk: 'zh-HK',
};

/**
 * Where the bare origin sends a visitor nothing else places
 * (rootRedirectGuard), and the x-default of every page's hreflang set.
 */
export const DEFAULT_REGION = 'tw';

/** Each language named in itself, the same in every locale. */
export const LANG_LABELS: Record<Lang, string> = {
  'zh-TW': '中文 (繁體)',
  'zh-HK': '中文 (香港)',
  'en': 'English',
};

/**
 * Loaded language tables. Every language, English included, is fetched on
 * demand by I18nService.loadLang — the app initializer loads the visitor's
 * language before the first render — so none sits in the initial bundle.
 * English used to be imported here, 67 kB in every visitor's first load
 * whatever their language.
 */
export const TRANSLATIONS: Partial<Record<Lang, Record<string, string>>> = {};
