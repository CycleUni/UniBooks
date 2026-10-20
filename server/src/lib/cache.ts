import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env';
import { afterResponse } from './http';
import { takePlatformRate } from '../middleware/rateLimit';

/**
 * Read-through cache in Workers KV for data that is the same for every
 * visitor (reference data, sitemap pages, public lists).
 *
 * Keys are versioned per namespace: `c:<ns>:<version>:<key>`. Writers that
 * change the underlying rows call `invalidate(env, ns)`, which bumps the
 * namespace version, so every reader switches to fresh keys at once and the
 * old entries simply expire — no listing or deleting of keys. KV is
 * eventually consistent (seconds to propagate across locations), which is
 * fine for everything cached here.
 *
 * Namespaces in use:
 *   ref      regions, currencies, schools, categories (admin edits)
 *   search   course facets (they follow categories)
 *   sitemap  sitemap index and pages (listing/book changes are not tracked:
 *            the TTL alone bounds staleness)
 *
 * A route that writes source rows says so with `invalidates(...)` next to
 * its handler, so a new write route cannot quietly leave stale copies.
 * Staleness after a write: other isolates may hold the old version for up
 * to VERSION_MEMO_MS, plus KV's propagation (up to about a minute).
 *
 * The write's response names the new versions in X-Cache-Version
 * (`ref=…, search=…`). The SPA sends the one it knows back as `?v=` on the
 * public lists it reads (versionedEdgeCache), so the browser that made the
 * change gets a new URL — no copy from its HTTP cache — and the server skips
 * its memo for it. Other visitors keep their browser copy until max-age.
 */
export type CacheNamespace = 'ref' | 'sitemap' | 'search';

const MIN_TTL = 60; // KV's minimum expirationTtl
const versionMemo = new Map<CacheNamespace, { value: string; at: number }>();
const VERSION_MEMO_MS = 30_000;
/** A memo is re-read for a newer `want` at most this often: `?v=` is in the URL, so anyone can vary it. */
const REFETCH_MIN_MS = 1_000;
/** A write's version reaches every isolate within VERSION_MEMO_MS plus KV propagation; older ones are not waited for. */
const WANT_MAX_AGE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 5_000;

/**
 * Whether `want` can be a version a recent write reported (versions are
 * `Date.now()` in base 36) that is newer than `have`. Anything else in `?v=`
 * is ignored rather than allowed to skip the memo and the edge cache.
 */
function plausiblyNewer(want: string, have: string): boolean {
  if (!/^[0-9a-z]{1,11}$/.test(want)) return false;
  const at = parseInt(want, 36);
  const now = Date.now();
  return at > (parseInt(have, 36) || 0) && at <= now + CLOCK_SKEW_MS && now - at <= WANT_MAX_AGE_MS;
}

/** `ns`'s current version; a plausibly newer `want` (a version a client saw) re-reads a memo that differs. */
async function version(env: Env, ns: CacheNamespace, want?: string): Promise<string> {
  const memo = versionMemo.get(ns);
  if (memo && Date.now() - memo.at < VERSION_MEMO_MS) {
    const recheck = want && want !== memo.value && plausiblyNewer(want, memo.value) && Date.now() - memo.at >= REFETCH_MIN_MS;
    if (!recheck) return memo.value;
  }
  const value = (await env.KV.get(`c:ver:${ns}`)) ?? '0';
  versionMemo.set(ns, { value, at: Date.now() });
  return value;
}

/**
 * Make every cached entry of `ns` stale (call after writing the source rows).
 * The new version is known at once; `written` settles once KV has it.
 */
function bump(env: Env, ns: CacheNamespace): { value: string; written: Promise<void> } {
  const value = Date.now().toString(36);
  versionMemo.set(ns, { value, at: Date.now() });
  return { value, written: env.KV.put(`c:ver:${ns}`, value) };
}

export async function invalidate(env: Env, ns: CacheNamespace): Promise<void> {
  await bump(env, ns).written;
}

/**
 * `fn()`'s result, cached for `ttlSeconds` under `key` in namespace `ns`.
 * A KV failure never fails the request: the value is computed instead.
 */
export async function cached<T>(env: Env, ns: CacheNamespace, key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  let fullKey: string | null = null;
  try {
    fullKey = `c:${ns}:${await version(env, ns)}:${key}`;
    const hit = await env.KV.get<T>(fullKey, 'json');
    if (hit !== null) return hit;
  } catch (e) {
    console.warn(`[cache] read failed for ${ns}:${key}`, e);
  }
  const value = await fn();
  if (fullKey) {
    try {
      await env.KV.put(fullKey, JSON.stringify(value), { expirationTtl: Math.max(MIN_TTL, ttlSeconds) });
    } catch (e) {
      console.warn(`[cache] write failed for ${ns}:${key}`, e);
    }
  }
  return value;
}

/**
 * Route middleware for writes to cached source rows: after a successful
 * response, every listed namespace is invalidated, and the response tells the
 * client the new versions (X-Cache-Version).
 */
export function invalidates(...namespaces: CacheNamespace[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.res.status >= 400) return;
    const bumped = namespaces.map((ns) => ({ ns, ...bump(c.env, ns) }));
    c.header('X-Cache-Version', bumped.map(({ ns, value }) => `${ns}=${value}`).join(', '));
    await afterResponse(c, Promise.all(bumped.map((b) => b.written)));
  };
}

/**
 * A viewer-independent GET answered from the edge cache (caches.default),
 * built on a miss. The key is the URL with `v` set to `version`, so bumping
 * the version switches every location to fresh entries. Only public answers
 * that vary on nothing outside the URL are stored, for their own
 * Cache-Control max-age — or for `edgeTtl` seconds when given (or what the
 * function returns for the answer built), which keeps the edge copy without
 * letting browsers keep one.
 *
 * This saves the KV and D1 reads and the CPU of building the answer; the
 * Worker still runs. Workers Cache (which would skip it) bills every static
 * asset request too, so it is not used.
 */
/** Seconds the edge keeps an answer; a function decides from the answer built. */
type EdgeTtl = number | ((res: Response) => number | Promise<number>);

export async function edgeCache(
  c: Context<AppEnv>,
  version: string,
  build: () => Promise<Response>,
  { edgeTtl }: { edgeTtl?: EdgeTtl } = {},
): Promise<Response> {
  const url = new URL(c.req.url);
  url.searchParams.set('v', version);
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await caches.default.match(key);
  if (hit) {
    // A copy: the cache's Response has immutable headers, and middleware adds some.
    const res = new Response(hit.body, hit);
    if (edgeTtl) res.headers.delete('Cache-Control');
    return res;
  }
  const res = await build();
  const ttl = typeof edgeTtl === 'function' ? await edgeTtl(res) : edgeTtl;
  const cacheControl = ttl ? `public, max-age=${ttl}` : (res.headers.get('Cache-Control') ?? '');
  if (res.ok && !res.headers.has('Vary') && /^public\b/.test(cacheControl) && /max-age=[1-9]/.test(cacheControl)) {
    const stored = new Response(res.clone().body, res);
    stored.headers.set('Cache-Control', cacheControl);
    const put = caches.default.put(key, stored).catch((e) => console.warn('[cache] edge put failed', e));
    await afterResponse(c, put);
  }
  return res;
}

/**
 * edgeCache() under `ns`'s version, for the public lists the SPA asks for
 * with the `?v=` an admin write reported. A recent `?v=` this location has
 * not caught up with (KV still propagating) is answered from the source with
 * no-store, so neither the edge nor the browser keeps it under the newer URL;
 * CACHE_BYPASS_LIMIT caps how often one client gets that. Any other `?v=`
 * gets the cached copy.
 */
export async function versionedEdgeCache(c: Context<AppEnv>, ns: CacheNamespace, build: () => Promise<Response>): Promise<Response> {
  const want = c.req.query('v') || undefined;
  let current: string;
  try {
    current = await version(c.env, ns, want);
  } catch (e) {
    console.warn(`[cache] version read failed for ${ns}`, e);
    return build();
  }
  if (
    want &&
    want !== current &&
    plausiblyNewer(want, current) &&
    (await takePlatformRate(c, c.env.CACHE_BYPASS_LIMIT, 'cache-bypass', '20/min'))
  ) {
    const res = await build();
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
  return edgeCache(c, current, build);
}

/**
 * A few seconds of edge cache for a public, viewer-independent GET that no
 * write invalidates (search results, the listing feed): a burst of identical
 * requests costs D1 once per location instead of once per request, and a new
 * listing shows up within `ttlSeconds`.
 *
 * Cached only when the URL itself names everything the answer depends on:
 * `region` and `lang` (the SPA always sends both; without them the region
 * could come from a header or the visitor's country, which the key does not
 * see). Otherwise, and when `viewerFree` is false (a signed-in visitor's
 * answer carries their own state), the answer is built every time.
 */
export function publicEdgeCache(
  c: Context<AppEnv>,
  ttlSeconds: EdgeTtl,
  build: () => Promise<Response>,
  { viewerFree = true }: { viewerFree?: boolean } = {},
): Promise<Response> {
  if (c.req.method !== 'GET' || !viewerFree || !c.req.query('region') || !c.req.query('lang')) return build();
  return edgeCache(c, 'public', build, { edgeTtl: ttlSeconds });
}

/**
 * A small key/value store in the edge cache (caches.default) for caches whose
 * keys a visitor can multiply, such as search text or ISBNs. Writes are free
 * and unlimited, where KV's free plan allows 1000 a day, a budget a script
 * could spend in minutes and take the version and e-mail de-duplication keys
 * down with it. Entries live per location and may be evicted early: a miss
 * only costs the work again.
 */
const storeRequest = (key: string) => new Request(`https://cache.internal/${encodeURIComponent(key)}`);

export async function storeGet(key: string): Promise<string | null> {
  const hit = await caches.default.match(storeRequest(key));
  return hit ? hit.text() : null;
}

export async function storePut(key: string, value: string, ttlSeconds: number): Promise<void> {
  const headers = { 'Cache-Control': `public, max-age=${Math.max(1, ttlSeconds)}` };
  await caches.default.put(storeRequest(key), new Response(value, { headers }));
}
