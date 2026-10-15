/**
 * Link-preview tags for /<region>/book, filled in at the edge.
 *
 * LINE, Facebook, Slack and friends read a shared link's <head> without
 * running JavaScript, so the tags SeoService writes in the browser never
 * reach them and every book shared from the site previewed as the bare site
 * name with no cover. src/routes/frontend.ts puts the same facts into the
 * region's static app shell (served through env.ASSETS); everything that
 * decides *what* to write lives here, with the asset fetch, the book lookup,
 * the cache and the HTML rewrite passed in, so the tests can drive it with
 * stubs (test/frontend/bookMeta.spec.ts).
 *
 * The book comes from this same Worker (an in-process call to
 * /api/v1/books/).
 */

import { escapeHtml } from '../../lib/html';
import { UUID_RE } from '../../lib/uuid';

export const SITE_NAME = 'UniBooks';

/** Past this, a crawler gets the untouched page rather than waiting longer.
 *  The lookup is in-process now, but a book the catalogue has not seen yet
 *  still goes out to Google Books / Open Library, and link-preview fetchers
 *  give up after a few seconds. */
export const API_TIMEOUT_MS = 2500;

/** Book facts are stable; an hour keeps a popular book to ~24 lookups a day
 *  per Cloudflare location. A miss (API 404) is kept briefly, because the
 *  API also answers 404 when an external catalogue lookup failed. */
export const FOUND_TTL_SECONDS = 3600;
export const MISSING_TTL_SECONDS = 300;
export const ERROR_TTL_SECONDS = 10;

export type BookIdentity = { kind: 'isbn' | 'id'; value: string };

/** The fields of the book API response this needs, and nothing else — the
 *  response also carries listings with seller names, which are not cached. */
export interface BookFacts {
  id: string;
  isbn13: string;
  title: string;
  authors: string;
  cover_url: string;
}

export type LookupResult = { status: 'found'; book: BookFacts } | { status: 'missing' } | { status: 'error' };

export interface BookMeta {
  title: string;
  description: string;
  canonical: string;
  image: string | null;
  alternates: Array<{ href: string; hreflang: string }>;
}

export type DescriptionLang = 'en' | 'zh-TW' | 'zh-HK';

/** Same wording as the app's seo.bookDescription keys; the spec holds them equal. */
export const DESCRIPTIONS: Record<DescriptionLang, { withAuthor: string; noAuthor: string }> = {
  en: {
    withAuthor: '{title} by {authors}. Buy it second-hand from students on UniBooks.',
    noAuthor: '{title}. Buy it second-hand from students on UniBooks.',
  },
  'zh-TW': {
    withAuthor: '《{title}》，{authors} 著。在 UniBooks 向同學購買二手書。',
    noAuthor: '《{title}》。在 UniBooks 向同學購買二手書。',
  },
  'zh-HK': {
    withAuthor: '《{title}》，{authors} 著。在 UniBooks 向同學購買二手書。',
    noAuthor: '《{title}》。在 UniBooks 向同學購買二手書。',
  },
};

/** A region a book page exists under: its lowercase code and page language. */
export interface SiteRegion {
  code: string;
  lang: string;
}

/** The active regions (in display order) and the x-default one. */
export interface SiteRegions {
  regions: SiteRegion[];
  defaultRegion: string;
}

/**
 * The page a region's other routes are served from (named by the app's
 * region build): in the region's
 * language and with no canonical of its own. Asked for by name, so the page
 * served here never depends on which _redirects rewrite would have picked it.
 */
export const REGION_SHELL = 'app-shell';

/** Region codes are ISO 3166-1 alpha-2 in lowercase, as the app's URLs spell
 *  them. Whether the code names an *active* region is the caller's check. */
export function regionFrom(param: unknown): string | null {
  return typeof param === 'string' && /^[a-z]{2}$/.test(param) ? param : null;
}

/** isbn wins over id, matching the book page itself. Anything malformed is
 *  left to the SPA rather than forwarded to the API. Book ids are UUIDs. */
export function bookIdentity(url: URL): BookIdentity | null {
  const isbn = url.searchParams.get('isbn');
  if (isbn) return /^\d{10}(\d{3})?$|^\d{9}[\dX]$/i.test(isbn) ? { kind: 'isbn', value: isbn.toUpperCase() } : null;
  const id = url.searchParams.get('id');
  if (id) return UUID_RE.test(id) ? { kind: 'id', value: id.toLowerCase() } : null;
  return null;
}

/**
 * Cache API key. Built from the parsed identity rather than the request URL,
 * so `?utm_source=`, `&engine=` and parameter order do not split one book
 * into many entries. Never fetched; it only has to be a URL.
 */
export function cacheKey(origin: string, region: string, identity: BookIdentity): string {
  return `${origin}/__book-meta/v1/${region}/${identity.kind}/${encodeURIComponent(identity.value)}`;
}

/** The same-origin book API URL the app itself calls. */
export function bookApiUrl(origin: string, region: string, identity: BookIdentity): string {
  const params = new URLSearchParams({ [identity.kind]: identity.value, region });
  return `${origin}/api/v1/books?${params.toString()}`;
}

/**
 * Link-preview fetchers and search crawlers: the clients that cannot run the
 * app. Only these wait for the API on a cache miss. A false negative costs a
 * preview without a cover; a false positive costs one visitor up to
 * API_TIMEOUT_MS. So app names that also appear in in-app browser UAs
 * ("Line/13.x", "Slack/4.x") are not matched on their own: LINE's fetcher
 * identifies as facebookexternalhit plus line-poker, Slack's as Slackbot.
 */
export function isLinkPreviewAgent(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return /bot\b|bot\/|crawler|spider|facebookexternalhit|line-poker|whatsapp\/|skypeuripreview|embedly|vkshare|bingpreview|google-inspectiontool|kakaotalk-scrap|iframely/i.test(
    userAgent,
  );
}

function descriptionLang(lang: string | undefined): DescriptionLang {
  return lang && lang in DESCRIPTIONS ? (lang as DescriptionLang) : 'en';
}

/** Same transform as the app's BookCoverPipe at zoom 2, made absolute: a
 *  preview image must be a full URL, and Google's zoom=1 thumbnail is too
 *  small for most preview cards. */
export function coverImageUrl(origin: string, coverUrl: string): string | null {
  if (!coverUrl) return null;
  let src: URL;
  try {
    src = new URL(coverUrl);
  } catch {
    return null;
  }
  if (src.hostname === 'books.google.com') {
    src.searchParams.set('zoom', '2');
    src.searchParams.delete('edge');
    src.protocol = 'https:';
  } else if (src.hostname !== 'covers.openlibrary.org' && src.hostname !== 'pdsapp.ncl.edu.tw') {
    return src.protocol === 'https:' ? src.toString() : null;
  }
  return `${origin}/api/cover?src=${encodeURIComponent(src.toString())}`;
}

export function pickBookFacts(body: unknown): BookFacts | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const title = text(b['title']).trim();
  if (!title) return null;
  return {
    id: text(b['id']),
    isbn13: text(b['isbn13']),
    title,
    authors: text(b['authors']).trim(),
    cover_url: text(b['cover_url']),
  };
}

export function metaFor(book: BookFacts, origin: string, region: string, site: SiteRegions): BookMeta {
  const lang = site.regions.find((r) => r.code === region)?.lang;
  const strings = DESCRIPTIONS[descriptionLang(lang)];
  const template = book.authors ? strings.withAuthor : strings.noAuthor;
  const description = template.replaceAll('{title}', book.title).replaceAll('{authors}', book.authors);
  // The ISBN form whenever there is one, like the app's own canonical: the
  // same book is also reachable by id and with an &engine= hint.
  const query = book.isbn13 ? `isbn=${encodeURIComponent(book.isbn13)}` : `id=${encodeURIComponent(book.id)}`;

  // Every region's copy of this page, and the default region's as
  // x-default (DEFAULT_REGION), so every link points both ways.
  const alternates = [
    ...site.regions.map((r) => ({ href: `${origin}/${r.code}/book?${query}`, hreflang: r.lang })),
    { href: `${origin}/${site.defaultRegion}/book?${query}`, hreflang: 'x-default' },
  ];

  return {
    title: `${book.title} · ${SITE_NAME}`,
    description,
    canonical: `${origin}/${region}/book?${query}`,
    image: coverImageUrl(origin, book.cover_url),
    alternates,
  };
}

/** Tags appended to <head>. <title> and the description already exist in
 *  the shell and are rewritten in place instead. */
export function headTags(meta: BookMeta): string {
  const tag = (attr: 'property' | 'name', key: string, content: string) => `<meta ${attr}="${key}" content="${escapeHtml(content)}">`;
  const alternateTags = meta.alternates.map(
    (alt) => `<link rel="alternate" hreflang="${escapeHtml(alt.hreflang)}" href="${escapeHtml(alt.href)}">`,
  );
  return [
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}">`,
    ...alternateTags,
    tag('property', 'og:site_name', SITE_NAME),
    tag('property', 'og:type', 'book'),
    tag('property', 'og:title', meta.title),
    tag('property', 'og:description', meta.description),
    tag('property', 'og:url', meta.canonical),
    ...(meta.image ? [tag('property', 'og:image', meta.image)] : []),
    // Without a cover the page keeps the site's 1200x630 card, which is
    // just as wide as a cover would be shown.
    tag('name', 'twitter:card', 'summary_large_image'),
  ].join('');
}

/** The page's own copies, removed before the book's are appended: with two
 *  canonicals a search engine may ignore both, and preview fetchers differ
 *  on which of two og:title tags they read. The site's og:image stays when
 *  the book has no cover, with its size and alt, so its preview still has
 *  the site's card. */
const REPLACED_HEAD_TAGS = ['link[rel="canonical"]', 'link[rel="alternate"][hreflang]', 'meta[property^="og:"]', 'meta[name^="twitter:"]'];

/** Streams `page` with the tags for `meta` written in, under `status`. */
export function injectBookMeta(page: Response, meta: BookMeta, status: number): Response {
  let rewriter = new HTMLRewriter();
  for (const selector of REPLACED_HEAD_TAGS) {
    rewriter = rewriter.on(selector, {
      element(el) {
        if (!meta.image && el.getAttribute('property')?.startsWith('og:image')) return;
        el.remove();
      },
    });
  }
  const rewritten = rewriter
    .on('title', {
      element(el) {
        el.setInnerContent(meta.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute('content', meta.description);
      },
    })
    .on('head', {
      element(el) {
        el.append(headTags(meta), { html: true });
      },
    })
    .transform(page);
  return new Response(rewritten.body, { status, headers: withoutValidators(rewritten.headers) });
}

/** The shell's ETag and Last-Modified describe the file, not the page with
 *  a book written into it; a browser revalidating against them would be
 *  told a different page is unchanged. */
function withoutValidators(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return headers;
}

export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface BookPageContext {
  request: Request;
  /** Lowercase code of an active region (checked by the caller). */
  region: string;
  site: SiteRegions;
  /** The region's app shell from the static assets. */
  shell: () => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface BookPageDeps {
  cache: CacheLike;
  /** Answers a same-origin book API URL (in production: this Worker's own app). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Streams `page` with the tags for `meta` written in, under `status`. */
  inject: (page: Response, meta: BookMeta, status: number) => Response;
  timeoutMs?: number;
}

async function lookup(url: string, deps: BookPageDeps): Promise<LookupResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // An in-process call does not watch the signal, so the timeout races it
  // as well as aborting it.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, deps.timeoutMs ?? API_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([deps.fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } }), timeout]);
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) return { status: 'error' };
    const book = pickBookFacts(await Promise.race([response.json(), timeout]));
    return book ? { status: 'found', book } : { status: 'error' };
  } catch {
    return { status: 'error' };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function readCache(cache: CacheLike, key: string): Promise<LookupResult | null> {
  try {
    const hit = await cache.match(key);
    return hit ? ((await hit.json()) as LookupResult) : null;
  } catch {
    return null;
  }
}

async function writeCache(cache: CacheLike, key: string, result: LookupResult): Promise<void> {
  const ttl = result.status === 'found' ? FOUND_TTL_SECONDS : result.status === 'missing' ? MISSING_TTL_SECONDS : ERROR_TTL_SECONDS;
  try {
    await cache.put(
      key,
      new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
      }),
    );
  } catch {
    // A cache that will not store is a slower page, not a broken one.
  }
}

/**
 * Every failure path — malformed query, API error or timeout, a page that is
 * not HTML — returns the region's shell untouched, so the worst case is the
 * plain SPA.
 *
 * On a cache miss only a preview agent waits for the API. Anyone else gets
 * the page at once and the lookup runs after the response (waitUntil), which
 * warms this location for the crawler that follows a share.
 */
export async function handleBookPage(ctx: BookPageContext, deps: BookPageDeps): Promise<Response> {
  const url = new URL(ctx.request.url);
  const region = ctx.region;
  const identity = bookIdentity(url);

  const page = await ctx.shell();
  if (!identity || !page.ok || !(page.headers.get('content-type') ?? '').includes('text/html')) {
    return page;
  }

  try {
    const key = cacheKey(url.origin, region, identity);
    let result = await readCache(deps.cache, key);
    if (!result) {
      const apiUrl = bookApiUrl(url.origin, region, identity);
      const fetchAndStore = lookup(apiUrl, deps).then(async (fresh) => {
        await writeCache(deps.cache, key, fresh);
        return fresh;
      });
      if (!isLinkPreviewAgent(ctx.request.headers.get('user-agent'))) {
        ctx.waitUntil(fetchAndStore);
        return page;
      }
      result = await fetchAndStore;
    }

    if (result.status === 'error') {
      return page;
    }
    if (result.status === 'missing') {
      // The SPA would show its not-found state; say so in the status too.
      return new Response(page.body, { status: 404, headers: page.headers });
    }
    return deps.inject(page, metaFor(result.book, url.origin, region, ctx.site), page.status);
  } catch {
    return page;
  }
}
