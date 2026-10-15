import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env';
import { afterResponse } from './http';

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

/** `ns`'s current version; `want` (a version a client saw) bypasses a memo that differs. */
async function version(env: Env, ns: CacheNamespace, want?: string): Promise<string> {
  const memo = versionMemo.get(ns);
  if (memo && Date.now() - memo.at < VERSION_MEMO_MS && (!want || memo.value === want)) return memo.value;
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
 * built on a miss. The key is the URL with `v` set to `ns`'s current
 * version, so an invalidation switches every location to fresh entries, and
 * an entry lives as long as the response's own Cache-Control max-age. Only
 * public answers that vary on nothing outside the URL are stored.
 *
 * A `?v=` this location has not caught up with (KV still propagating) is
 * answered from the source with no-store, so neither the edge nor the
 * browser keeps it under the newer URL.
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
  if (want && want !== current) {
    const res = await build();
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
  const url = new URL(c.req.url);
  url.searchParams.set('v', current);
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await caches.default.match(key);
  // A copy: the cache's Response has immutable headers, and middleware adds some.
  if (hit) return new Response(hit.body, hit);
  const res = await build();
  const cacheControl = res.headers.get('Cache-Control') ?? '';
  if (res.ok && !res.headers.has('Vary') && /^public\b/.test(cacheControl) && /max-age=[1-9]/.test(cacheControl)) {
    const put = caches.default.put(key, res.clone()).catch((e) => console.warn(`[cache] edge put failed for ${ns}`, e));
    await afterResponse(c, put);
  }
  return res;
}
