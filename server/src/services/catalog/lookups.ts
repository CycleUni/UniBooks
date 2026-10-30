/**
 * External catalogue lookups (Google Books, Open Library, the ISBNnet
 * resolver). Results are cached at the edge: hits for 30 days (ISBN) / 24 h
 * (keyword), misses for 24 h (a Google ISBN miss no title search confirmed:
 * 10 minutes), and a global 10-second "Google is rate-limiting us" flag.
 * A KV failure degrades to a live call, never to an error.
 */
import type { Env, IsbnnetLookup } from '../../env';
import type { Region } from '../../db';
import { cleanPublisher, type Engine, cleanCoverUrl } from './common';
import { isbnForms } from './isbn';
import { storeGet, storePut } from '../../lib/cache';
import type { RateLimiter } from '../../durable-objects/RateLimiter';

export interface BookRecord {
  title: string;
  authors: string;
  publisher: string;
  published_date: string;
  cover_url: string;
  isbn: string | null;
  source?: string;
  debug_source?: string | null;
  /** Google's volume id, when Google supplied the record: it addresses the volume even where no ISBN query finds it. */
  google_id?: string;
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
const NOT_FOUND_TTL = 86400;
const ISBN_HIT_TTL = 86400 * 30;
const QUERY_HIT_TTL = 86400;
const GOOGLE_RATE_LIMIT_KEY = 'gb:rate_limited';
const GOOGLE_RATE_LIMIT_TTL_MS = 10_000;
const ISBNNET_DOWN_KEY = 'isbnnet:down';
const ISBNNET_DOWN_TTL_MS = 90_000;
const USER_AGENT = 'UniBooks Backend Service';

// ---------------------------------------------------------------- cache ----

// Kept in the edge cache, not KV: every ISBN and search text is a new key a
// visitor can make up, and KV's free plan allows only 1000 writes a day.
async function cacheGet(_env: Env, key: string): Promise<string | null> {
  try {
    return await storeGet(`catalog:${key}`);
  } catch (e) {
    console.warn('[catalog] cache get failed; treating as a miss', key, e);
    return null;
  }
}

async function cacheSet(_env: Env, key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await storePut(`catalog:${key}`, value, ttlSeconds);
  } catch (e) {
    console.warn('[catalog] cache set failed; continuing uncached', key, e);
  }
}

async function googleRateLimited(env: Env): Promise<boolean> {
  const until = Number(await cacheGet(env, GOOGLE_RATE_LIMIT_KEY));
  return Number.isFinite(until) && until > Date.now();
}

async function markGoogleRateLimited(env: Env): Promise<void> {
  // Stored as an expiry timestamp, so a copy that outlives its TTL still reads as expired.
  await cacheSet(env, GOOGLE_RATE_LIMIT_KEY, String(Date.now() + GOOGLE_RATE_LIMIT_TTL_MS), 60);
}

async function isbnnetDown(env: Env): Promise<boolean> {
  const until = Number(await cacheGet(env, ISBNNET_DOWN_KEY));
  return Number.isFinite(until) && until > Date.now();
}

async function markIsbnnetDown(env: Env): Promise<void> {
  await cacheSet(env, ISBNNET_DOWN_KEY, String(Date.now() + ISBNNET_DOWN_TTL_MS), 120);
}

/**
 * Google answers 429 when throttled and 403 once the daily quota is spent:
 * both mean "stop asking for a while", or every later search keeps paying a
 * round trip that cannot succeed.
 */
const googleThrottled = (res: Response) => res.status === 429 || res.status === 403;

/** One cache entry (and one upstream call) per query, whatever its case and spacing. */
export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
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

/** A search for `q`, or with `volumeId` that one volume. */
function googleUrl(env: Env, q: string | null, extra: Record<string, string> = {}, volumeId?: string): string {
  const u = new URL(volumeId ? `${GOOGLE_BOOKS_API_URL}/${encodeURIComponent(volumeId)}` : GOOGLE_BOOKS_API_URL);
  if (q !== null) u.searchParams.set('q', q);
  const key = env.GOOGLE_BOOKS_API_KEY;
  if (key && !key.startsWith('dev-only')) u.searchParams.set('key', key);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * One budget for every Google Books call this Worker makes, across all
 * users and isolates (a single RateLimiter instance): per-user limits alone
 * let many accounts together spend the API key's daily quota. Over budget,
 * a call answers as Google would when throttling (429), so callers back off
 * and fall back to the other sources. GOOGLE_BOOKS_PER_MINUTE overrides it.
 */
const DEFAULT_GOOGLE_PER_MINUTE = 60;

async function withinGoogleBudget(env: Env): Promise<boolean> {
  if (env.ENVIRONMENT === 'test') return true;
  const limit = Number(env.GOOGLE_BOOKS_PER_MINUTE) || DEFAULT_GOOGLE_PER_MINUTE;
  try {
    const ns = env.RATE_LIMITER as DurableObjectNamespace<RateLimiter>;
    return (await ns.get(ns.idFromName('google-books:global')).hit(limit, 60)).allowed;
  } catch (e) {
    console.warn('[catalog] Google budget check failed; allowing the call', e);
    return true;
  }
}

async function googleFetch(env: Env, q: string | null, extra?: Record<string, string>, volumeId?: string): Promise<Response> {
  if (!(await withinGoogleBudget(env))) return new Response(null, { status: 429 });
  return fetch(googleUrl(env, q, extra, volumeId), {
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

/**
 * Google answers isbn: from replicas that disagree: about half the calls for
 * a volume every replica holds come back empty, at random (seen across ten
 * ISBNs, 2026-10). One miss proves little, so a miss is asked again.
 */
const GOOGLE_ISBN_TRIES = 3;

/** The volume isbn:`isbn` names, asked up to GOOGLE_ISBN_TRIES times; 'error' when Google answered with neither. */
async function googleVolumeByIsbnQuery(env: Env, isbn: string): Promise<GoogleVolumeInfo | null | 'error'> {
  for (let i = 0; i < GOOGLE_ISBN_TRIES; i++) {
    const res = await googleFetch(env, `isbn:${isbn}`);
    if (googleThrottled(res)) {
      await markGoogleRateLimited(env);
      throw new GoogleBooksRateLimited(`429 for isbn=${isbn}`);
    }
    if (res.status !== 200) return 'error';
    const data = (await res.json()) as { totalItems?: number; items?: Array<{ volumeInfo?: GoogleVolumeInfo }> };
    if ((data.totalItems ?? 0) > 0 && data.items?.length) return data.items[0].volumeInfo ?? {};
  }
  return null;
}

/** A plain search for `q` whose results include a volume carrying that exact ISBN. */
async function googleVolumeWithIsbn(env: Env, isbn: string, q: string): Promise<GoogleVolumeInfo | null> {
  const res = await googleFetch(env, q, { maxResults: '40' });
  if (googleThrottled(res)) {
    await markGoogleRateLimited(env);
    throw new GoogleBooksRateLimited(`429 for title search, isbn=${isbn}`);
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

/** Google volume ids are short URL-safe tokens (e.g. Ps8SEQAAQBAJ). */
export const GOOGLE_VOLUME_ID_RE = /^[A-Za-z0-9_-]{6,24}$/;

/**
 * The volume a link names by id, if it carries `isbn`. The id comes from the
 * URL, so it is only a pointer: the volume must hold the ISBN on record.
 */
async function googleVolumeById(env: Env, isbn: string, volumeId: string): Promise<GoogleVolumeInfo | null> {
  if (!GOOGLE_VOLUME_ID_RE.test(volumeId)) return null;
  const res = await googleFetch(env, null, undefined, volumeId);
  if (googleThrottled(res)) {
    await markGoogleRateLimited(env);
    throw new GoogleBooksRateLimited(`429 for volume=${volumeId}`);
  }
  if (res.status !== 200) return null;
  const info = ((await res.json()) as { volumeInfo?: GoogleVolumeInfo }).volumeInfo ?? {};
  const wanted = isbnForms(isbn);
  return (info.industryIdentifiers ?? []).some((x) => wanted.has((x.identifier ?? '').toUpperCase())) ? info : null;
}

/**
 * A title search finds what isbn: missed: it answers the same every time
 * (seen: 9786263338272), and the volume it returns carries the ISBN on
 * record. ISBNnet names the book; its main title (the part before the
 * subtitle) is the search, and only a volume carrying the exact ISBN counts.
 * Without this the book page showed ISBNnet's coverless record for a book the
 * search page showed from Google. `searched` says whether a title search ran:
 * without one, a miss rests on isbn: alone.
 */
async function googleVolumeByRegistryTitle(env: Env, isbn: string): Promise<{ info: GoogleVolumeInfo | null; searched: boolean }> {
  const named = await getIsbnnetBookByIsbn(env, isbn);
  const title = named?.title.split(/[：:]/)[0].trim();
  return title ? { info: await googleVolumeWithIsbn(env, isbn, title), searched: true } : { info: null, searched: false };
}

/**
 * How long a miss no title search confirmed is kept: ISBNnet was down or does
 * not list the book, so the next visitor's isbn: tries may well find it.
 */
const UNCONFIRMED_MISS_TTL = 600;

/**
 * `volumeId` is the Google volume a shared search-result link names: asked
 * first, and past a cached not-found, since isbn: finds a volume only some
 * of the time (seen: 9783819246562, 9786263338272).
 */
export async function getGoogleBooksByIsbn(env: Env, isbn: string, meta?: LookupMeta, volumeId?: string): Promise<BookRecord | null> {
  const key = `gb:isbn:${isbn}`;
  const cached = await cachedOr<BookRecord | null>(env, key, meta, null);
  if (cached.hit && (cached.value !== null || !volumeId)) return cached.value;
  if (meta) meta.cache_hit = false;
  if (await googleRateLimited(env)) {
    if (meta) meta.status = 'rate_limited';
    throw new GoogleBooksRateLimited(`cached rate-limit, isbn=${isbn}`);
  }
  try {
    let item = volumeId ? await googleVolumeById(env, isbn, volumeId) : null;
    if (item === null) {
      const found = await googleVolumeByIsbnQuery(env, isbn);
      if (found === 'error') {
        if (meta) meta.status = 'error';
        return null;
      }
      item = found;
    }
    let confirmed = true;
    if (item === null) {
      const byTitle = await googleVolumeByRegistryTitle(env, isbn);
      item = byTitle.info;
      confirmed = byTitle.searched;
    }
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
    await cacheSet(env, key, NOT_FOUND_SENTINEL, confirmed ? NOT_FOUND_TTL : UNCONFIRMED_MISS_TTL);
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

export async function searchGoogleBooks(env: Env, rawQuery: string, meta?: LookupMeta): Promise<BookRecord[]> {
  const query = normalizeQuery(rawQuery);
  const key = `gb:q:${await sha1(query)}`;
  const cached = await cachedOr<BookRecord[]>(env, key, meta, []);
  if (cached.hit) return cached.value;
  if (await googleRateLimited(env)) {
    if (meta) meta.status = 'rate_limited';
    throw new GoogleBooksRateLimited('cached rate-limit');
  }
  try {
    const res = await googleFetch(env, query);
    if (googleThrottled(res)) {
      await markGoogleRateLimited(env);
      if (meta) meta.status = 'rate_limited';
      throw new GoogleBooksRateLimited('429 for query');
    }
    if (res.status !== 200) {
      if (meta) meta.status = 'error';
      return [];
    }
    const data = (await res.json()) as { items?: Array<{ id?: string; volumeInfo?: GoogleVolumeInfo }> };
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
        ...(item.id && GOOGLE_VOLUME_ID_RE.test(item.id) ? { google_id: item.id } : {}),
      };
    });
    await cacheSet(env, key, JSON.stringify(results), QUERY_HIT_TTL);
    // Google's isbn: lookup misses volumes its own search returns, so the
    // book page a result links to fell through to ISBNnet (no cover) — the
    // search card and its page disagreed. Each result is the record for its
    // ISBN that the visitor just saw; let the ISBN lookup answer with it.
    await Promise.all(
      results
        .filter((r) => r.isbn && /^\d{13}$/.test(r.isbn))
        .map((r) => cacheSet(env, `gb:isbn:${r.isbn}`, JSON.stringify(r), ISBN_HIT_TTL)),
    );
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

export async function searchOpenLibraryBooks(env: Env, rawQuery: string, meta?: LookupMeta): Promise<BookRecord[]> {
  const query = normalizeQuery(rawQuery);
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
 * data). Called over RPC through the ISBNNET service binding — an in-process
 * call that never leaves Cloudflare and needs no secret — or, where the
 * binding is not connected (local dev without the resolver running), over
 * HTTPS at ISBNNET_RESOLVER_URL, GET /isbn/<isbn> with the shared secret in
 * X-Resolver-Secret when set.
 */
async function callIsbnnet(env: Env, isbn: string): Promise<IsbnnetLookup | null> {
  if (env.ISBNNET) {
    try {
      return await withTimeout(env.ISBNNET.lookup(isbn), EXTERNAL_API_TIMEOUT_MS);
    } catch (e) {
      // A binding with no Worker behind it (wrangler dev without the resolver)
      // throws; only then is the public URL worth a try.
      if (!env.ISBNNET_RESOLVER_URL || isTimeout(e)) throw e;
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
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (env.ISBNNET_RESOLVER_SECRET) headers['X-Resolver-Secret'] = env.ISBNNET_RESOLVER_SECRET;
  // No redirects: the shared secret must only ever reach the resolver itself.
  const res = await fetch(`${base}/isbn/${encodeURIComponent(isbn)}`, {
    headers,
    signal: AbortSignal.timeout(EXTERNAL_API_TIMEOUT_MS),
    redirect: 'manual',
  });
  if (res.status === 200) return { status: 'found', book: await res.json() };
  // 404 is either answer the resolver caches: not listed, or not an ISBN.
  return { status: res.status === 404 ? 'not_found' : 'upstream_error' };
}

/** An RPC call has no AbortSignal; this gives it the same deadline a fetch gets. */
function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  const deadline = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  return Promise.race([call, deadline]);
}

export async function getIsbnnetBookByIsbn(env: Env, isbn: string, meta?: LookupMeta): Promise<BookRecord | null> {
  const key = `isbnnet:isbn:${isbn}`;
  const cached = await cachedOr<BookRecord | null>(env, key, meta, null);
  if (cached.hit) return cached.value;
  // The National Central Library site goes quiet for hours at a time; once a
  // call has failed, skip it for a while instead of making each visitor wait
  // out the timeout before the next engine gets its turn.
  if (await isbnnetDown(env)) {
    if (meta) meta.status = 'error';
    return null;
  }
  try {
    const res = await callIsbnnet(env, isbn);
    if (!res) {
      if (meta) meta.status = 'error';
      return null;
    }
    if (res.status === 'found') {
      const data = res.book;
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
    if (res.status === 'not_found' || res.status === 'invalid_isbn') {
      await cacheSet(env, key, NOT_FOUND_SENTINEL, NOT_FOUND_TTL);
      if (meta) meta.status = 'not_found';
      return null;
    }
    await markIsbnnetDown(env);
    if (meta) meta.status = 'error';
    return null;
  } catch (e) {
    await markIsbnnetDown(env);
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
