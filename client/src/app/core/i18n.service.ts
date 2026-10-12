import { Injectable, Pipe, PipeTransform, inject, signal, effect } from '@angular/core';
import { Lang, TRANSLATIONS, SUPPORTED_LANGS, REGION_TO_LANG } from './i18n/index';

const STORAGE_KEY = 'lang';
/** Set once the visitor has answered the device-language suggestion, or picked a language by hand. */
const SUGGESTION_KEY = 'langSuggestion';

/**
 * The site language for a browser language tag, for a first visit with no
 * stored choice. Only Chinese tags choose a Chinese variant: this used to
 * match 'hk' anywhere in the tag, so en-HK — the usual setting for English
 * speakers in Hong Kong — opened the site in Chinese.
 */
export function langFromBrowserTag(tag: string | undefined | null): Lang {
  const lang = (tag || '').toLowerCase().replace(/_/g, '-');
  if (lang.startsWith('yue')) return 'zh-HK';
  if (lang.startsWith('zh')) {
    return lang.includes('hk') || lang.includes('yue') ? 'zh-HK' : 'zh-TW';
  }
  return 'en';
}

/**
 * The language of the region a URL path is under — `/tw/…` is zh-TW,
 * `/hk/…` zh-HK — or null for a path without a region prefix.
 *
 * A first visit that lands on a region page reads it in that region's
 * language, whatever the browser says. Search crawlers render with an
 * English browser and no stored choice, so going by the browser alone had
 * Google index /tw/ in English while its hreflang called it zh-TW.
 */
export function langFromPath(pathname: string | undefined | null): Lang | null {
  const first = (pathname || '').split('/')[1]?.toLowerCase() ?? '';
  return Object.prototype.hasOwnProperty.call(REGION_TO_LANG, first) ? REGION_TO_LANG[first] : null;
}

/**
 * The language to offer a visitor whose device prefers one other than the
 * page's, or null when there is nothing better to offer.
 *
 * `tags` is navigator.languages, most preferred first; `offered` is what the
 * current region's pages come in (a language outside it would be undone by
 * the next region check). The first tag that names a site language the region
 * offers wins — so ['ja', 'zh-HK'] on a Hong Kong page offers nothing rather
 * than English. A device with no Chinese or English tag at all is offered
 * English, the site's only language for everyone else.
 */
export function suggestedLang(
  tags: readonly string[],
  offered: readonly string[],
  current: Lang,
): Lang | null {
  let pick: Lang | null = null;
  for (const tag of tags) {
    const lower = (tag || '').toLowerCase();
    if (!/^(zh|yue|en)\b/.test(lower)) continue;
    const lang = langFromBrowserTag(lower);
    if (offered.includes(lang)) {
      pick = lang;
      break;
    }
  }
  if (!pick && tags.length > 0 && offered.includes('en')) pick = 'en';
  return pick && pick !== current ? pick : null;
}

@Injectable({
  providedIn: 'root',
})
export class I18nService {
  readonly lang = signal<Lang>(this.initialLang());
  private loadPromises = new Map<Lang, Promise<void>>();

  constructor() {
    effect(() => this.syncDocumentLang(this.lang()));
  }

  private syncDocumentLang(lang: Lang) {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }

  private initialLang(): Lang {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY) as Lang;
      if (SUPPORTED_LANGS.includes(stored)) {
        return stored;
      }
    }
    const lang =
      langFromPath(typeof location !== 'undefined' ? location.pathname : '') ??
      langFromBrowserTag(typeof navigator !== 'undefined' ? navigator.language : '');
    // Kept, so the language a first visit opened in survives the next load.
    // Without it a visitor who entered at the bare origin (browser language)
    // and was redirected to /tw/ would reload into the region's language.
    // A failed write must not take the constructor down with it.
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Storage blocked or full: this visit still opens in `lang`.
    }
    return lang;
  }

  async loadLang(lang: Lang): Promise<void> {
    if (TRANSLATIONS[lang]) return;

    if (this.loadPromises.has(lang)) {
      return this.loadPromises.get(lang)!;
    }

    const promise = (async () => {
      try {
        if (lang === 'en') {
          const m = await import('./i18n/en');
          TRANSLATIONS['en'] = m.en;
        } else if (lang === 'zh-TW') {
          const m = await import('./i18n/zh-TW');
          TRANSLATIONS['zh-TW'] = m.zhTW;
        } else if (lang === 'zh-HK') {
          const m = await import('./i18n/zh-HK');
          TRANSLATIONS['zh-HK'] = m.zhHK;
        }
      } catch (e) {
        console.error('Failed to load i18n dict for', lang, e);
      }
    })();

    this.loadPromises.set(lang, promise);
    await promise;
  }

  async setLang(lang: Lang) {
    await this.loadLang(lang);
    this.lang.set(lang);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, lang);
    }
  }

  /** Whether the device-language suggestion has been answered (or made moot by a hand-picked language). */
  suggestionSettled(): boolean {
    try {
      return localStorage.getItem(SUGGESTION_KEY) === '1';
    } catch {
      // No storage, no memory of an answer: asking on every load would nag.
      return true;
    }
  }

  settleSuggestion() {
    try {
      localStorage.setItem(SUGGESTION_KEY, '1');
    } catch {
      // Storage blocked: the answer only lasts this page view.
    }
  }

  /**
   * `t()` in a given language rather than the current one, for text meant
   * for a reader of that language — the suggestion to switch to it. The
   * table must already be loaded (loadLang); English stands in otherwise.
   */
  tIn(lang: Lang, key: string, params?: Record<string, string | number>): string {
    let text = TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS['en']?.[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  }

  t(key: string, params?: Record<string, string | number>): string {
    // English is the fallback only when it happens to be loaded: every
    // language declares every key (i18n-keys.spec), so a loaded table rarely
    // lacks one, and fetching English just for that would undo lazy loading.
    let text = TRANSLATIONS[this.lang()]?.[key] ?? TRANSLATIONS['en']?.[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  }

  /**
   * `t()`, but null instead of the key when there is no translation.
   *
   * Use this for anything whose key comes from outside the app — chiefly the
   * `error.code` the backend returns. `t()` echoes an unknown key back, which
   * is a reasonable default while developing a template (you see immediately
   * what is missing) and a bad one for a value the frontend does not control:
   * the backend can emit a code no locale declares, and the user is then shown
   * `listing.errFileTooLarge` where a sentence should be.
   */
  tOrNull(key: unknown, params?: Record<string, string | number>): string | null {
    if (typeof key !== 'string' || !key) return null;
    const text = this.t(key, params);
    return text === key ? null : text;
  }
}

@Pipe({
  name: 't',
  standalone: true,
  pure: false,
})
export class TPipe implements PipeTransform {
  private i18n = inject(I18nService);

  transform(key: string, params?: Record<string, string | number>): string {
    return this.i18n.t(key, params);
  }
}
