/**
 * External catalogue lookups (Google Books, Open Library, the ISBNnet
 * resolver). Results are cached in KV: hits for 30 days (ISBN) / 24 h
 * (keyword), confirmed misses for an hour, and a global 10-second "Google is rate-limiting us" flag.
 * A KV failure degrades to a live call, never to an error.
 */
import type { Env } from '../../env';
import type { Region } from '../../db';
import { cleanPublisher, type Engine, cleanCoverUrl } from './common';
import { isbnForms } from './isbn';

export interface BookRecord {
  title: string;
  authors: string;
  publisher: string;
  published_date: string;
  cover_url: string;
  isbn: string | null;
  source?: string;
  debug_source?: string | null;
}

export type LookupStatus = 'found' | 'not_found' | 'timeout' | 'rate_limited' | 'error';

export interface LookupMeta {
  status?: LookupStatus;
  cache_hit?: boolean;
}

export class GoogleBooksRateLimited extends Error {}

const GOOGLE_BOOKS_API_URL = 'https://www.googleapis.com/books/v1/volumes';
const OPEN_LIBRARY_SEARCH_URL = 'https://openlibrary.org/search.json';
const OPEN_LIBRARY_ISBN_URL = 'https://openlibrary.org/api/books';
const OPEN_LIBRARY_COVER_URL = (id: number | string) => `https://covers.openlibrary.org/b/id/${id}-M.jpg`;

const EXTERNAL_API_TIMEOUT_MS = 5000;
const NOT_FOUND_SENTINEL = '__gb_not_found__';
const NOT_FOUND_TTL = 3600;
const ISBN_HIT_TTL = 86400 * 30;
const QUERY_HIT_TTL = 86400;
const GOOGLE_RATE_LIMIT_KEY = 'gb:rate_limited';
const GOOGLE_RATE_LIMIT_TTL_MS = 10_000;
const USER_AGENT = 'UniBooks Backend Service';

// ---------------------------------------------------------------- cache ----

async function cacheGet(env: Env, key: string): Promise<string | null> {
  try {
    return (await env.KV?.get(`catalog:${key}`)) ?? null;
  } catch (e) {
    console.warn('[catalog] cache get failed; treating as a miss', key, e);
    return null;
  }
}

async function cacheSet(env: Env, key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    // KV's minimum TTL is 60 s.
    await env.KV?.put(`catalog:${key}`, value, { expirationTtl: Math.max(60, ttlSeconds) });
  } catch (e) {
    console.warn('[catalog] cache set failed; continuing uncached', key, e);
  }
}

async function googleRateLimited(env: Env): Promise<boolean> {
  const until = Number(await cacheGet(env, GOOGLE_RATE_LIMIT_KEY));
  return Number.isFinite(until) && until > Date.now();
}

async function markGoogleRateLimited(env: Env): Promise<void> {
  // Stored as an expiry timestamp: KV cannot hold a 10-second TTL itself.
  await cacheSet(env, GOOGLE_RATE_LIMIT_KEY, String(Date.now() + GOOGLE_RATE_LIMIT_TTL_MS), 60);
}

async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

async function cachedOr<T>(
  env: Env,
  key: string,
  meta: LookupMeta | undefined,
  empty: T,
): Promise<{ hit: true; value: T } | { hit: false }> {
  const cached = await cacheGet(env, key);
  if (cached === null) {
    if (meta) meta.cache_hit = false;
    return { hit: false };
  }
  if (meta) meta.cache_hit = true;
  if (cached === NOT_FOUND_SENTINEL) {
    if (meta) meta.status = 'not_found';
    return { hit: true, value: empty };
  }
  try {
    const value = JSON.parse(cached) as T;
    if (meta) meta.status = 'found';
    return { hit: true, value };
  } catch {
    if (meta) meta.cache_hit = false;
    return { hit: false };
  }
}

// --------------------------------------------------------- Google Books ----

function googleUrl(env: Env, q: string, extra: Record<string, string> = {}): string {
  const u = new URL(GOOGLE_BOOKS_API_URL);
  u.searchParams.set('q', q);
  const key = env.GOOGLE_BOOKS_API_KEY;
  if (key && !key.startsWith('dev-only')) u.searchParams.set('key', key);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

async function googleFetch(env: Env, q: string, extra?: Record<string, string>): Promise<Response> {
  return fetch(googleUrl(env, q, extra), {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(EXTERNAL_API_TIMEOUT_MS),
  });
}

interface GoogleVolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  imageLinks?: { thumbnail?: string };
  industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
}

function googleCover(info: GoogleVolumeInfo): string {
  return cleanCoverUrl((info.imageLinks?.thumbnail ?? '').replace(/^http:/, 'https:')) ?? '';
}

/** A plain search for `isbn` whose volume carries that exact ISBN (Google's isbn: operator misses some). */
async function googleVolumeWithIsbn(env: Env, isbn: string): Promise<GoogleVolumeInfo | null> {
  const res = await googleFetch(env, isbn, { maxResults: '40' });
  if (res.status === 429) {
    await markGoogleRateLimited(env);
    throw new GoogleBooksRateLimited(`429 for plain isbn=${isbn}`);
  }
  if (res.status !== 200) return null;
  const wanted = isbnForms(isbn);
  const data = (await res.json()) as { items?: Array<{ volumeInfo?: GoogleVolumeInfo }> };
  for (const volume of data.items ?? []) {
    const info = volume.volumeInfo ?? {};
    for (const x of info.industryIdentifiers ?? []) {
      if (wanted.has((x.identifier ?? '').toUpperCase())) return info;
    }
  }
  return null;
}

export async function getGoogleBooksByIsbn(env: Env, isbn: string, meta?: LookupMeta): Promise<BookRecord | null> {
  const key = `gb:isbn:${isbn}`;
  const cached = await cachedOr<BookRecord | null>(env, key, meta, null);
  if (cached.hit) return cached.value;
  if (await googleRateLimited(env)) {
    if (meta) meta.status = 'rate_limited';
    throw new GoogleBooksRateLimited(`cached rate-limit, isbn=${isbn}`);
  }
  try {
    const res = await googleFetch(env, `isbn:${isbn}`);
    if (res.status === 429) {
      await markGoogleRateLimited(env);
      if (meta) meta.status = 'rate_limited';
      throw new GoogleBooksRateLimited(`429 for isbn=${isbn}`);
    }
    if (res.status !== 200) {
      if (meta) meta.status = 'error';
      return null;
    }
    const data = (await res.json()) as { totalItems?: number; items?: Array<{ volumeInfo?: GoogleVolumeInfo }> };
    let item: GoogleVolumeInfo | null = (data.totalItems ?? 0) > 0 && data.items?.length ? (data.items[0].volumeInfo ?? {}) : null;
    if (item === null) item = await googleVolumeWithIsbn(env, isbn);
    if (item !== null) {
      const result: BookRecord = {
        title: item.title ?? '',
        authors: (item.authors ?? []).join(', '),
        publisher: String(cleanPublisher(item.publisher ?? '')),
        published_date: item.publishedDate ?? '',
        cover_url: googleCover(item),
        isbn,
      };
      await cacheSet(env, key, JSON.stringify(result), ISBN_HIT_TTL);
      if (meta) meta.status = 'found';
      return result;
    }
    await cacheSet(env, key, NOT_FOUND_SENTINEL, NOT_FOUND_TTL);
    if (meta) meta.status = 'not_found';
    return null;
  } catch (e) {
    if (e instanceof GoogleBooksRateLimited) {
      if (meta) meta.status = 'rate_limited';
      throw e;
    }
    if (meta) meta.status = isTimeout(e) ? 'timeout' : 'error';
    console.warn('[catalog] Google Books ISBN lookup failed', isbn, e);
    return null;
  }
}

export async function searchGoogleBooks(env: Env, query: string, meta?: LookupMeta): Promise<BookRecord[]> {
  const key = `gb:q:${await sha1(query)}`;
  const cached = await cachedOr<BookRecord[]>(env, key, meta, []);
  if (cached.hit) return cached.value;
  if (await googleRateLimited(env)) {
    if (meta) meta.status = 'rate_limited';
    throw new GoogleBooksRateLimited('cached rate-limit');
  }
  try {
    const res = await googleFetch(env, query);
    if (res.status === 429) {
      await markGoogleRateLimited(env);
      if (meta) meta.status = 'rate_limited';
      throw new GoogleBooksRateLimited('429 for query');
    }
    if (res.status !== 200) {
      if (meta) meta.status = 'error';
      return [];
    }
    const data = (await res.json()) as { items?: Array<{ volumeInfo?: GoogleVolumeInfo }> };
    const items = data.items ?? [];
    if (!items.length) {
      await cacheSet(env, key, NOT_FOUND_SENTINEL, NOT_FOUND_TTL);
      if (meta) meta.status = 'not_found';
      return [];
    }
    const results: BookRecord[] = items.slice(0, 10).map((item) => {
      const info = item.volumeInfo ?? {};
      return {
        title: info.title ?? '',
        authors: (info.authors ?? []).join(', '),
        publisher: String(cleanPublisher(info.publisher ?? '')),
        published_date: info.publishedDate ?? '',
        cover_url: googleCover(info),
        isbn: (info.industryIdentifiers ?? []).find((x) => x.type === 'ISBN_13')?.identifier ?? null,
      };
    });
    await cacheSet(env, key, JSON.stringify(results), QUERY_HIT_TTL);
    if (meta) meta.status = 'found';
    return results;
  } catch (e) {
    if (e instanceof GoogleBooksRateLimited) throw e;
    if (meta) meta.status = isTimeout(e) ? 'timeout' : 'error';
    console.warn('[catalog] Google Books search failed', e);
    return [];
  }
}

// --------------------------------------------------------- Open Library ----

export async function getOpenLibraryBookByIsbn(env: Env, isbn: string, meta?: LookupMeta): Promise<BookRecord | null> {
  const key = `ol:isbn:${isbn}`;
  const cached = await cachedOr<BookRecord | null>(env, key, meta, null);
  if (cached.hit) return cached.value;
  try {
    const u = new URL(OPEN_LIBRARY_ISBN_URL);
    u.searchParams.set('bibkeys', `ISBN:${isbn}`);
    u.searchParams.set('format', 'json');
    u.searchParams.set('jscmd', 'data');
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(EXTERNAL_API_TIMEOUT_MS) });
    if (res.status !== 200) {
      if (meta) meta.status = 'error';
      return null;
    }
    const data = (await res.json()) as Record<
      string,
      {
        title?: string;
        authors?: Array<{ name?: string }>;
        publishers?: Array<{ name?: string }>;
        publish_date?: string;
        cover?: { medium?: string };
      }
    >;
    const entry = data[`ISBN:${isbn}`];
    if (!entry) {
      await cacheSet(env, key, NOT_FOUND_SENTINEL, NOT_FOUND_TTL);
      if (meta) meta.status = 'not_found';
      return null;
    }
    const result: BookRecord = {
      title: entry.title ?? '',
      authors: (entry.authors ?? []).map((a) => a.name ?? '').join(', '),
      publisher: String(cleanPublisher((entry.publishers ?? []).map((p) => p.name ?? '').join(', '))),
      published_date: entry.publish_date ?? '',
      cover_url: cleanCoverUrl(entry.cover?.medium) ?? '',
      isbn,
    };
    await cacheSet(env, key, JSON.stringify(result), ISBN_HIT_TTL);
    if (meta) meta.status = 'found';
    return result;
  } catch (e) {
    if (meta) meta.status = isTimeout(e) ? 'timeout' : 'error';
    console.warn('[catalog] Open Library ISBN lookup failed', isbn, e);
    return null;
  }
}

export async function searchOpenLibraryBooks(env: Env, query: string, meta?: LookupMeta): Promise<BookRecord[]> {
  const key = `ol:q:${await sha1(query)}`;
  const cached = await cachedOr<BookRecord[]>(env, key, meta, []);
  if (cached.hit) return cached.value;
  try {
    const u = new URL(OPEN_LIBRARY_SEARCH_URL);
    u.searchParams.set('q', query);
    u.searchParams.set('limit', '10');
    // search.json omits isbn unless asked; without it every result is dropped by the dedup.
    u.searchParams.set('fields', 'title,author_name,publisher,first_publish_year,cover_i,isbn');
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(EXTERNAL_API_TIMEOUT_MS) });
    if (res.status !== 200) {
      if (meta) meta.status = 'error';
      return [];
    }
    const data = (await res.json()) as {
      docs?: Array<{
        title?: string;
        author_name?: string[];
        publisher?: string[];
        first_publish_year?: number;
        cover_i?: number;
        isbn?: string[];
      }>;
    };
    const docs = (data.docs ?? []).slice(0, 10);
    if (!docs.length) {
      await cacheSet(env, key, NOT_FOUND_SENTINEL, NOT_FOUND_TTL);
      if (meta) meta.status = 'not_found';
      return [];
    }
    const results: BookRecord[] = docs.map((doc) => {
      const isbns = doc.isbn ?? [];
      const isbn13 = isbns.find((i) => i.length === 13) ?? isbns[0] ?? null;
      return {
        title: doc.title ?? '',
        authors: (doc.author_name ?? []).join(', '),
        publisher: String(cleanPublisher((doc.publisher ?? [''])[0] ?? '')),
        published_date: doc.first_publish_year === undefined ? '' : String(doc.first_publish_year),
        cover_url: doc.cover_i ? OPEN_LIBRARY_COVER_URL(doc.cover_i) : '',
        isbn: isbn13,
      };
    });
    await cacheSet(env, key, JSON.stringify(results), QUERY_HIT_TTL);
    if (meta) meta.status = 'found';
    return results;
  } catch (e) {
    if (meta) meta.status = isTimeout(e) ? 'timeout' : 'error';
    console.warn('[catalog] Open Library search failed', e);
    return [];
  }
}

// ---------------------------------------------------------------- ISBNnet ----

/**
 * The ISBNnet resolver (a separate Worker over National Central Library
 * data), GET /isbn/<isbn>. Called through the ISBNNET service binding — an
 * in-process call that never leaves Cloudflare — or, where the binding is not
 * connected (local dev without the resolver running), over HTTPS at
 * ISBNNET_RESOLVER_URL. The shared secret goes in X-Resolver-Secret when set.
 */
async function callIsbnnet(env: Env, isbn: string): Promise<Response | null> {
  const path = `/isbn/${encodeURIComponent(isbn)}`;
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (env.ISBNNET_RESOLVER_SECRET) headers['X-Resolver-Secret'] = env.ISBNNET_RESOLVER_SECRET;
  // No redirects: the shared secret must only ever reach the resolver itself.
  const init: RequestInit = { headers, signal: AbortSignal.timeout(EXTERNAL_API_TIMEOUT_MS), redirect: 'manual' };
  if (env.ISBNNET) {
    try {
      const res = await env.ISBNNET.fetch(`https://isbnnet-resolver${path}`, init);
      // A binding with no Worker behind it (wrangler dev without the resolver)
      // answers 503; only then is the public URL worth a try.
      if (res.status < 500 || !env.ISBNNET_RESOLVER_URL) return res;
    } catch (e) {
      if (!env.ISBNNET_RESOLVER_URL) throw e;
    }
  }
  const base = (env.ISBNNET_RESOLVER_URL ?? '').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  // HTTPS, or plain HTTP only to this machine during local development.
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) return null;
  return fetch(`${base}${path}`, init);
}

export async function getIsbnnetBookByIsbn(env: Env, isbn: string, meta?: LookupMeta): Promise<BookRecord | null> {
  const key = `isbnnet:isbn:${isbn}`;
  const cached = await cachedOr<BookRecord | null>(env, key, meta, null);
  if (cached.hit) return cached.value;
  try {
    const res = await callIsbnnet(env, isbn);
    if (!res) {
      if (meta) meta.status = 'error';
      return null;
    }
    if (res.status === 200) {
      const data = (await res.json()) as Partial<Record<keyof BookRecord, string>>;
      const result: BookRecord = {
        title: data.title ?? '',
        authors: data.authors ?? '',
        publisher: String(cleanPublisher(data.publisher ?? '')),
        published_date: data.published_date ?? '',
        cover_url: cleanCoverUrl(data.cover_url) ?? '',
        isbn: data.isbn ?? isbn,
      };
      await cacheSet(env, key, JSON.stringify(result), ISBN_HIT_TTL);
      if (meta) meta.status = 'found';
      return result;
    }
    if (res.status === 404) {
      await cacheSet(env, key, NOT_FOUND_SENTINEL, NOT_FOUND_TTL);
      if (meta) meta.status = 'not_found';
      return null;
    }
    if (meta) meta.status = 'error';
    return null;
  } catch (e) {
    if (meta) meta.status = isTimeout(e) ? 'timeout' : 'error';
    console.warn('[catalog] ISBNnet lookup failed', isbn, e);
    return null;
  }
}

// ---------------------------------------------------------------- engines ----

export const VALID_SEARCH_ENGINES: readonly Engine[] = ['googlebooks', 'openlibrary', 'isbnnet'];
export const ISBN_FALLBACK_ORDER: readonly Engine[] = ['googlebooks', 'isbnnet', 'openlibrary'];
export const KEYWORD_FALLBACK_ORDER: readonly Engine[] = ['googlebooks', 'openlibrary'];
export const SOURCE_BY_ENGINE: Record<Engine, 'google_api' | 'openlibrary_api' | 'isbnnet_api'> = {
  googlebooks: 'google_api',
  openlibrary: 'openlibrary_api',
  isbnnet: 'isbnnet_api',
};

/** The engines the region's admin settings allow; none configured → Google only. */
export function regionSearchEngines(region: Region | null): Engine[] {
  let configured: unknown = (region as Record<string, unknown> | null)?.searchEngines;
  if (typeof configured === 'string') {
    try {
      configured = JSON.parse(configured);
    } catch {
      configured = [];
    }
  }
  const allowed = Array.isArray(configured) ? configured.filter((e): e is Engine => VALID_SEARCH_ENGINES.includes(e as Engine)) : [];
  return allowed.length ? allowed : ['googlebooks'];
}

/** A named engine the region allows is used alone; otherwise the region's share of the fallback order. */
export function engineOrder(requested: string | null | undefined, allowed: Engine[], fallback: readonly Engine[]): Engine[] {
  if (requested && allowed.includes(requested as Engine)) return [requested as Engine];
  return fallback.filter((e) => allowed.includes(e));
}

export interface Attempt {
  engine: Engine;
  status: LookupStatus;
  cache_hit: boolean;
}

export type LookupFn<R> = (env: Env, query: string, meta?: LookupMeta) => Promise<R>;

/**
 * Ask each engine in order until one answers. A Google rate limit also hands
 * over to Open Library when the region allows it.
 */
export async function lookupInOrder<R>(
  env: Env,
  query: string,
  orderIn: readonly Engine[],
  lookups: Partial<Record<Engine, LookupFn<R>>>,
  allowed: Engine[],
): Promise<{ result: R | null; engine: Engine | null; meta: LookupMeta & { attempts: Attempt[] }; googleUnavailable: boolean }> {
  const order = [...orderIn];
  let result: R | null = null;
  let engine: Engine | null = null;
  let meta: LookupMeta = {};
  let googleUnavailable = false;
  const attempts: Attempt[] = [];
  for (let i = 0; i < order.length; i++) {
    engine = order[i];
    meta = {};
    const fn = lookups[engine];
    try {
      result = fn ? await fn(env, query, meta) : null;
    } catch (e) {
      if (!(e instanceof GoogleBooksRateLimited)) throw e;
      googleUnavailable = true;
      result = null;
      meta.status = 'rate_limited';
      if (allowed.includes('openlibrary') && !order.includes('openlibrary')) order.push('openlibrary');
    }
    const truthy = Array.isArray(result) ? result.length > 0 : !!result;
    attempts.push({ engine, status: meta.status ?? (truthy ? 'found' : 'not_found'), cache_hit: meta.cache_hit ?? false });
    if (truthy) break;
  }
  return { result, engine, meta: { ...meta, attempts }, googleUnavailable };
}

export const ISBN_LOOKUPS: Record<Engine, LookupFn<BookRecord | null>> = {
  googlebooks: getGoogleBooksByIsbn,
  isbnnet: getIsbnnetBookByIsbn,
  openlibrary: getOpenLibraryBookByIsbn,
};

export const KEYWORD_LOOKUPS: Partial<Record<Engine, LookupFn<BookRecord[]>>> = {
  googlebooks: searchGoogleBooks,
  openlibrary: searchOpenLibraryBooks,
};
