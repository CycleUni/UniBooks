import * as fs from 'fs';
import * as path from 'path';
import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';

/**
 * public/theme-init.js preloads the translation table the app is about to
 * import, choosing the language with its own copy of I18nService's rules (it
 * runs before any of the app's code exists). A copy that drifts preloads a
 * table nobody uses and leaves the real one to wait; these hold the two to
 * the same answer.
 */
const CHUNKS = { en: 'chunk-en.js', 'zh-TW': 'chunk-tw.js', 'zh-HK': 'chunk-hk.js' };
const script = fs.readFileSync(path.join(process.cwd(), 'public/theme-init.js'), 'utf-8');

function preloaded(): string[] {
  return [...document.head.querySelectorAll('link[rel="modulepreload"]')].map(
    (l) => l.getAttribute('href') ?? '',
  );
}

describe('translation preload in theme-init.js', () => {
  let meta: HTMLMetaElement;

  beforeEach(() => {
    localStorage.clear();
    meta = document.createElement('meta');
    meta.name = 'unibooks-i18n-chunks';
    meta.content = JSON.stringify(CHUNKS);
    document.head.appendChild(meta);
  });

  afterEach(() => {
    meta.remove();
    document.head.querySelectorAll('link[rel="modulepreload"]').forEach((l) => l.remove());
    history.replaceState(null, '', '/');
    localStorage.clear();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  const cases: { stored: string | null; browser: string; path?: string }[] = [
    { stored: null, browser: 'zh-TW' },
    { stored: null, browser: 'zh-HK' },
    { stored: null, browser: 'zh_hk' },
    { stored: null, browser: 'yue' },
    { stored: null, browser: 'zh-Hant' },
    { stored: null, browser: 'en-HK' },
    { stored: null, browser: 'en-US' },
    { stored: null, browser: 'ja' },
    { stored: null, browser: '' },
    { stored: 'en', browser: 'zh-TW' },
    { stored: 'zh-HK', browser: 'en-US' },
    { stored: 'fr', browser: 'zh-TW' },
    { stored: null, browser: 'en-US', path: '/tw/' },
    { stored: null, browser: 'zh-TW', path: '/hk/search' },
    { stored: null, browser: 'en-US', path: '/messages' },
    { stored: 'en', browser: 'en-US', path: '/tw/' },
  ];

  for (const { stored, browser, path: at = '/' } of cases) {
    it(`preloads the language the app picks (stored ${stored}, browser "${browser}", at ${at})`, () => {
      history.replaceState(null, '', at);
      if (stored !== null) localStorage.setItem('lang', stored);
      vi.spyOn(navigator, 'language', 'get').mockReturnValue(browser);

      new Function(script)();
      const lang = TestBed.inject(I18nService).lang();

      expect(preloaded()).toEqual([`/${CHUNKS[lang]}`]);
    });
  }

  it('preloads nothing without the map, as on a build without stats', () => {
    meta.remove();
    new Function(script)();
    expect(preloaded()).toEqual([]);
  });

  it('ignores a chunk name that is not a plain file name', () => {
    meta.content = JSON.stringify({ ...CHUNKS, en: '//evil.example/x.js' });
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    new Function(script)();
    expect(preloaded()).toEqual([]);
  });
});
