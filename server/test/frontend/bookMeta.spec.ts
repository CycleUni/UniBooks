import { describe, it, expect, vi } from 'vitest';
import {
  BookMeta,
  BookPageDeps,
  CacheLike,
  DESCRIPTIONS,
  LookupResult,
  REGION_SHELL,
  SiteRegions,
  bookApiUrl,
  bookIdentity,
  cacheKey,
  coverImageUrl,
  handleBookPage,
  headTags,
  injectBookMeta,
  isLinkPreviewAgent,
  metaFor,
  regionFrom,
} from '../../src/services/frontend/bookMeta';
// The app's own strings: the descriptions written at the edge must read the
// same as the ones SeoService writes in the browser.
import { en } from '../../../client/src/app/core/i18n/en';
import { zhTW } from '../../../client/src/app/core/i18n/zh-TW';
import { zhHK } from '../../../client/src/app/core/i18n/zh-HK';

/**
 * services/frontend/bookMeta.ts, which writes link-preview tags into
 * /<region>/book.
 * A regression here only shows up as broken link previews — or, in the
 * failure the design guards against, a broken book page.
 */

const ORIGIN = 'https://unibooks.app';
const BOOK_ID = '0b7c3c1e-6a0e-4a8e-9a49-3e8f2b8e5a11';
const SITE: SiteRegions = {
  regions: [
    { code: 'tw', lang: 'zh-TW' },
    { code: 'hk', lang: 'zh-HK' },
  ],
  defaultRegion: 'tw',
};
const GOOGLE_COVER = 'https://books.google.com/books/content?id=UWlo-c4WEpAC&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api';
const BOOK = {
  id: BOOK_ID,
  isbn13: '9781449319793',
  title: 'Python for Data Analysis',
  authors: 'Wes McKinney',
  cover_url: GOOGLE_COVER,
  listings: { results: [{ seller_name: 'someone' }] },
};
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const LINE_PREVIEW = 'facebookexternalhit/1.1;line-poker/1.0';

describe('book link-preview page', () => {
  describe('reading the request', () => {
    it('accepts lowercase two-letter regions only', () => {
      expect(regionFrom('tw')).toBe('tw');
      expect(regionFrom('TW')).toBeNull();
      expect(regionFrom('messages')).toBeNull();
      expect(regionFrom(['tw'])).toBeNull();
    });

    it('identifies a book by a well-formed isbn, else a UUID id', () => {
      expect(bookIdentity(new URL(`${ORIGIN}/tw/book?id=${BOOK_ID}&isbn=9781449319793`))).toEqual({
        kind: 'isbn',
        value: '9781449319793',
      });
      expect(bookIdentity(new URL(`${ORIGIN}/tw/book?isbn=059652068x`))).toEqual({
        kind: 'isbn',
        value: '059652068X',
      });
      expect(bookIdentity(new URL(`${ORIGIN}/tw/book?id=${BOOK_ID.toUpperCase()}`))).toEqual({ kind: 'id', value: BOOK_ID });
      expect(bookIdentity(new URL(`${ORIGIN}/tw/book?id=2`))).toBeNull();
      expect(bookIdentity(new URL(`${ORIGIN}/tw/book?isbn=abc`))).toBeNull();
      expect(bookIdentity(new URL(`${ORIGIN}/tw/book?id=2%20OR%201`))).toBeNull();
      expect(bookIdentity(new URL(`${ORIGIN}/tw/book`))).toBeNull();
    });

    it('keys the cache by the book, not by the URL it was shared under', () => {
      const a = bookIdentity(new URL(`${ORIGIN}/tw/book?isbn=9781449319793&engine=googlebooks`))!;
      const b = bookIdentity(new URL(`${ORIGIN}/tw/book?utm_source=line&isbn=9781449319793`))!;
      expect(cacheKey(ORIGIN, 'tw', a)).toBe(cacheKey(ORIGIN, 'tw', b));
      expect(cacheKey(ORIGIN, 'tw', a)).not.toBe(cacheKey(ORIGIN, 'hk', a));
    });

    it('asks the same-origin API the way the app does', () => {
      expect(bookApiUrl(ORIGIN, 'tw', { kind: 'isbn', value: '9781449319793' })).toBe(
        `${ORIGIN}/api/v1/books?isbn=9781449319793&region=tw`,
      );
    });

    it('waits for the API only for clients that cannot run the app', () => {
      expect(isLinkPreviewAgent(LINE_PREVIEW)).toBe(true);
      expect(isLinkPreviewAgent('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).toBe(true);
      expect(isLinkPreviewAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
      expect(isLinkPreviewAgent('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')).toBe(true);
      expect(isLinkPreviewAgent('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)')).toBe(true);
      expect(isLinkPreviewAgent('TelegramBot (like TwitterBot)')).toBe(true);
      expect(isLinkPreviewAgent('WhatsApp/2.23.20.0')).toBe(true);
      expect(isLinkPreviewAgent(CHROME)).toBe(false);
      // A person reading in LINE's in-app browser must not wait on the API.
      expect(isLinkPreviewAgent(`${CHROME} Line/13.14.0`)).toBe(false);
      expect(isLinkPreviewAgent(null)).toBe(false);
    });
  });

  describe('what it writes', () => {
    it("describes the book in the region's language, with the app's wording", () => {
      for (const [lang, table] of [
        ['en', en],
        ['zh-TW', zhTW],
        ['zh-HK', zhHK],
      ] as const) {
        expect(DESCRIPTIONS[lang].withAuthor).toBe(table['seo.bookDescription']);
        expect(DESCRIPTIONS[lang].noAuthor).toBe(table['seo.bookDescriptionNoAuthor']);
      }
      const book = { id: BOOK_ID, isbn13: '9781449319793', title: 'Python for Data Analysis', authors: 'Wes McKinney', cover_url: '' };
      expect(metaFor(book, ORIGIN, 'tw', SITE).description).toBe(
        '《Python for Data Analysis》，Wes McKinney 著。在 UniBooks 向同學購買二手書。',
      );
      const withSg: SiteRegions = { ...SITE, regions: [...SITE.regions, { code: 'sg', lang: 'en' }] };
      expect(metaFor({ ...book, authors: '' }, ORIGIN, 'sg', withSg).description).toBe(
        'Python for Data Analysis. Buy it second-hand from students on UniBooks.',
      );
    });

    it('points the canonical at the isbn form, falling back to id', () => {
      const book = { id: BOOK_ID, isbn13: '9781449319793', title: 'T', authors: '', cover_url: '' };
      expect(metaFor(book, ORIGIN, 'tw', SITE).canonical).toBe(`${ORIGIN}/tw/book?isbn=9781449319793`);
      expect(metaFor({ ...book, isbn13: '' }, ORIGIN, 'tw', SITE).canonical).toBe(`${ORIGIN}/tw/book?id=${BOOK_ID}`);
      expect(metaFor(book, ORIGIN, 'tw', SITE).title).toBe('T · UniBooks');
    });

    it('names every active region copy as an hreflang alternate, with the default region as x-default', () => {
      const book = { id: BOOK_ID, isbn13: '9781449319793', title: 'T', authors: '', cover_url: '' };
      const tags = headTags(metaFor(book, ORIGIN, 'hk', SITE));
      expect(tags).toContain(`<link rel="alternate" hreflang="zh-TW" href="${ORIGIN}/tw/book?isbn=9781449319793">`);
      expect(tags).toContain(`<link rel="alternate" hreflang="zh-HK" href="${ORIGIN}/hk/book?isbn=9781449319793">`);
      expect(tags).toContain(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/tw/book?isbn=9781449319793">`);
      expect(tags).not.toContain('hreflang="en"');
    });

    it('uses the cover proxy at a size preview cards can use', () => {
      const image = coverImageUrl(ORIGIN, GOOGLE_COVER)!;
      expect(image.startsWith(`${ORIGIN}/api/cover?src=`)).toBe(true);
      const src = new URL(decodeURIComponent(image.split('src=')[1]));
      expect(src.searchParams.get('zoom')).toBe('2');
      expect(src.searchParams.has('edge')).toBe(false);
      expect(coverImageUrl(ORIGIN, 'https://covers.openlibrary.org/b/id/1-M.jpg')).toContain('/api/cover?src=');
      expect(coverImageUrl(ORIGIN, 'http://example.com/x.jpg')).toBeNull();
      expect(coverImageUrl(ORIGIN, '')).toBeNull();
    });

    it('escapes book data written into the head', () => {
      const tags = headTags({
        title: '"><script>alert(1)</script> · UniBooks',
        description: "O'Reilly & <b>",
        canonical: `${ORIGIN}/tw/book?id=1`,
        image: null,
        alternates: [],
      });
      expect(tags).not.toContain('<script>');
      expect(tags).toContain('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; · UniBooks"');
      expect(tags).toContain('content="O&#39;Reilly &amp; &lt;b&gt;"');
      expect(tags).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(tags).not.toContain('og:image');
    });

    it("replaces the shell's own tags rather than adding a second set", async () => {
      const shell = new Response(
        '<html><head><title>UniBooks</title><meta name="description" content="site">' +
          '<link rel="canonical" href="https://unibooks.app/tw/"><meta property="og:title" content="site">' +
          '<meta property="og:image" content="/og-image.png"></head><body></body></html>',
        { headers: { 'Content-Type': 'text/html', ETag: '"shell"' } },
      );
      const book = { id: BOOK_ID, isbn13: '9781449319793', title: 'T', authors: '', cover_url: GOOGLE_COVER };
      const out = injectBookMeta(shell, metaFor(book, ORIGIN, 'tw', SITE), 200);
      const html = await out.text();
      expect(html).toContain('<title>T · UniBooks</title>');
      expect(html.match(/rel="canonical"/g)).toHaveLength(1);
      expect(html.match(/og:title/g)).toHaveLength(1);
      expect(html).not.toContain('/og-image.png');
      expect(out.headers.get('ETag')).toBeNull();
    });
  });

  describe('serving the page', () => {
    const SHELL = '<!doctype html><html><head><title>UniBooks</title></head><body></body></html>';

    class MemoryCache implements CacheLike {
      store = new Map<string, string>();
      async match(key: string) {
        const body = this.store.get(key);
        return body === undefined ? undefined : new Response(body);
      }
      async put(key: string, response: Response) {
        this.store.set(key, await response.text());
      }
    }

    function setup(
      options: {
        ua?: string;
        url?: string;
        api?: (url: string, init: RequestInit) => Promise<Response>;
        page?: () => Response;
      } = {},
    ) {
      const cache = new MemoryCache();
      const pending: Promise<unknown>[] = [];
      const api = vi.fn(options.api ?? (async () => new Response(JSON.stringify(BOOK), { status: 200 })));
      const injected: Array<{ meta: BookMeta; status: number }> = [];
      const shell = vi.fn(
        async () => options.page?.() ?? new Response(SHELL, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      );
      const deps: BookPageDeps = {
        cache,
        fetch: (url, init) => api(url, init),
        inject: (page, meta, status) => {
          injected.push({ meta, status });
          return new Response('injected', { status, headers: page.headers });
        },
        timeoutMs: 20,
      };
      const run = () =>
        handleBookPage(
          {
            request: new Request(options.url ?? `${ORIGIN}/tw/book?isbn=9781449319793`, {
              headers: { 'User-Agent': options.ua ?? LINE_PREVIEW },
            }),
            region: 'tw',
            site: SITE,
            shell,
            waitUntil: (p) => {
              pending.push(p);
            },
          },
          deps,
        );
      return { cache, api, injected, shell, pending, run };
    }

    it('writes the tags for a crawler, and caches only the book facts', async () => {
      const t = setup();
      const response = await t.run();
      expect(await response.text()).toBe('injected');
      expect(response.status).toBe(200);
      expect(t.injected[0].meta.title).toBe('Python for Data Analysis · UniBooks');
      expect(t.shell).toHaveBeenCalledTimes(1);
      expect(t.api).toHaveBeenCalledWith(`${ORIGIN}/api/v1/books?isbn=9781449319793&region=tw`, expect.anything());
      const stored = [...t.cache.store.values()][0];
      expect(stored).not.toContain('someone');
      expect(JSON.parse(stored)).toEqual({
        status: 'found',
        book: expect.objectContaining({ isbn13: '9781449319793' }),
      });
    });

    it('does not make a person wait on a miss, but warms the cache behind them', async () => {
      const t = setup({ ua: CHROME });
      const response = await t.run();
      expect(await response.text()).toBe(SHELL);
      expect(t.injected).toEqual([]);
      await Promise.all(t.pending);
      expect(t.cache.store.size).toBe(1);

      // The crawler that follows the share is answered from the cache.
      const again = setup({ ua: LINE_PREVIEW });
      again.cache.store = t.cache.store;
      expect(await (await again.run()).text()).toBe('injected');
      expect(again.api).not.toHaveBeenCalled();
    });

    it('answers 404 when the API says the book does not exist', async () => {
      const t = setup({ api: async () => new Response('{}', { status: 404 }) });
      const response = await t.run();
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(SHELL);
      expect(JSON.parse([...t.cache.store.values()][0])).toEqual({ status: 'missing' } satisfies LookupResult);
    });

    it('serves the untouched page when the API fails, is slow, or answers nonsense', async () => {
      const failures: Array<(url: string, init: RequestInit) => Promise<Response>> = [
        async () => new Response('boom', { status: 500 }),
        async () => {
          throw new TypeError('network');
        },
        async () => new Response('not json', { status: 200 }),
        async () => new Response(JSON.stringify({ title: '' }), { status: 200 }),
        // Never answers and ignores the abort signal, as an in-process call does.
        () => new Promise<Response>(() => {}),
      ];
      for (const api of failures) {
        const t = setup({ api });
        const response = await t.run();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(SHELL);
        expect(t.cache.store.size).toBe(1);
        expect(JSON.parse([...t.cache.store.values()][0])).toEqual({ status: 'error' } satisfies LookupResult);
      }
    });

    it("serves the region's shell untouched for a book it has nothing to add to", async () => {
      for (const options of [{ url: `${ORIGIN}/tw/book` }, { url: `${ORIGIN}/tw/book?isbn=not-an-isbn` }]) {
        const t = setup(options);
        expect(await (await t.run()).text()).toBe(SHELL);
        expect(t.api).not.toHaveBeenCalled();
        expect(t.shell).toHaveBeenCalledTimes(1);
      }

      const notHtml = setup({
        page: () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      });
      expect(await (await notHtml.run()).text()).toBe('{}');
      expect(notHtml.api).not.toHaveBeenCalled();
    });

    it('treats an unreadable cache entry as a miss', async () => {
      const t = setup();
      const key = cacheKey(ORIGIN, 'tw', { kind: 'isbn', value: '9781449319793' });
      t.cache.store.set(key, 'not json');
      expect(await (await t.run()).text()).toBe('injected');
      expect(t.api).toHaveBeenCalledTimes(1);
    });
  });

  it('names the shell the FE build writes', () => {
    expect(REGION_SHELL).toBe('app-shell');
  });
});
