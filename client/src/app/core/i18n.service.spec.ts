import { TestBed } from '@angular/core/testing';
import { I18nService, langFromBrowserTag, langFromPath, suggestedLang } from './i18n.service';

describe('langFromBrowserTag', () => {
  it('keeps English speakers in Hong Kong on English', () => {
    expect(langFromBrowserTag('en-HK')).toBe('en');
    expect(langFromBrowserTag('en_HK')).toBe('en');
  });

  it('picks Hong Kong Chinese for Hong Kong and Cantonese tags', () => {
    expect(langFromBrowserTag('zh-HK')).toBe('zh-HK');
    expect(langFromBrowserTag('zh-Hant-HK')).toBe('zh-HK');
    expect(langFromBrowserTag('yue')).toBe('zh-HK');
    expect(langFromBrowserTag('yue-Hant-HK')).toBe('zh-HK');
    expect(langFromBrowserTag('zh-yue')).toBe('zh-HK');
  });

  it('picks Taiwan Chinese for other Chinese tags', () => {
    expect(langFromBrowserTag('zh-TW')).toBe('zh-TW');
    expect(langFromBrowserTag('zh-Hant')).toBe('zh-TW');
    expect(langFromBrowserTag('zh')).toBe('zh-TW');
  });

  it('falls back to English for anything else', () => {
    expect(langFromBrowserTag('en-US')).toBe('en');
    expect(langFromBrowserTag('ja-JP')).toBe('en');
    expect(langFromBrowserTag('')).toBe('en');
    expect(langFromBrowserTag(undefined)).toBe('en');
  });
});

describe('suggestedLang', () => {
  const TW = ['zh-TW', 'en'];
  const HK = ['zh-HK', 'en'];

  it('offers English to an English device on a Chinese page', () => {
    expect(suggestedLang(['en-US', 'en'], TW, 'zh-TW')).toBe('en');
    expect(suggestedLang(['en-HK'], HK, 'zh-HK')).toBe('en');
  });

  it('offers nothing when the page is already in the device language', () => {
    expect(suggestedLang(['zh-TW', 'en'], TW, 'zh-TW')).toBeNull();
    expect(suggestedLang(['en-GB'], TW, 'en')).toBeNull();
  });

  it('offers the Chinese the device prefers to an English page', () => {
    expect(suggestedLang(['zh-Hant-TW'], TW, 'en')).toBe('zh-TW');
    expect(suggestedLang(['yue-Hant-HK'], HK, 'en')).toBe('zh-HK');
  });

  it('offers English to a device in a language the site does not have', () => {
    expect(suggestedLang(['ja-JP'], TW, 'zh-TW')).toBe('en');
    expect(suggestedLang(['ko', 'fr'], HK, 'zh-HK')).toBe('en');
  });

  it('prefers a supported device language over the English fallback', () => {
    // A Japanese device that also reads Hong Kong Chinese is not pushed to English.
    expect(suggestedLang(['ja', 'zh-HK'], HK, 'zh-HK')).toBeNull();
    expect(suggestedLang(['ja', 'zh-TW'], TW, 'en')).toBe('zh-TW');
  });

  it('only offers languages the region offers', () => {
    // zh-HK is not a Taiwan page language; the next tag decides instead.
    expect(suggestedLang(['zh-HK', 'en'], TW, 'zh-TW')).toBe('en');
    expect(suggestedLang(['en'], ['zh-TW'], 'zh-TW')).toBeNull();
  });

  it('offers nothing without any device language', () => {
    expect(suggestedLang([], TW, 'zh-TW')).toBeNull();
  });
});

describe('langFromPath', () => {
  it('reads the region prefix as its language', () => {
    expect(langFromPath('/tw/')).toBe('zh-TW');
    expect(langFromPath('/tw')).toBe('zh-TW');
    expect(langFromPath('/hk/search')).toBe('zh-HK');
    expect(langFromPath('/TW/book')).toBe('zh-TW');
  });

  it('returns null for a path with no region prefix', () => {
    expect(langFromPath('/')).toBeNull();
    expect(langFromPath('')).toBeNull();
    expect(langFromPath(undefined)).toBeNull();
    expect(langFromPath('/messages')).toBeNull();
    expect(langFromPath('/constructor/')).toBeNull();
  });
});

describe('I18nService initial language', () => {
  const originalPath = location.pathname;

  function startAt(path: string, browser: string): I18nService {
    history.replaceState(null, '', path);
    vi.spyOn(navigator, 'language', 'get').mockReturnValue(browser);
    return TestBed.inject(I18nService);
  }

  beforeEach(() => localStorage.clear());

  afterEach(() => {
    history.replaceState(null, '', originalPath);
    localStorage.clear();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('opens a region page in its language for an English browser, as a crawler has', () => {
    expect(startAt('/tw/', 'en-US').lang()).toBe('zh-TW');
  });

  it('opens a Hong Kong page in Hong Kong Chinese for a Taiwan Chinese browser', () => {
    expect(startAt('/hk/search', 'zh-TW').lang()).toBe('zh-HK');
  });

  it('falls back to the browser language where the path has no region', () => {
    expect(startAt('/', 'en-US').lang()).toBe('en');
  });

  it('keeps a stored choice over the region', () => {
    localStorage.setItem('lang', 'en');
    expect(startAt('/tw/', 'zh-TW').lang()).toBe('en');
  });

  it('stores the first-visit language, so a reload after the root redirect keeps it', () => {
    startAt('/', 'en-US');
    expect(localStorage.getItem('lang')).toBe('en');
  });
});
