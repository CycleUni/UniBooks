import type { Env } from '../env';

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
 *   ref      regions, currencies, schools, cities, categories (admin edits)
 *   sitemap  sitemap index and pages (listing/book changes are not tracked:
 *            the TTL alone bounds staleness)
 */
export type CacheNamespace = 'ref' | 'sitemap' | 'search';

const MIN_TTL = 60; // KV's minimum expirationTtl
const versionMemo = new Map<CacheNamespace, { value: string; at: number }>();
const VERSION_MEMO_MS = 30_000;

async function version(env: Env, ns: CacheNamespace): Promise<string> {
  const memo = versionMemo.get(ns);
  if (memo && Date.now() - memo.at < VERSION_MEMO_MS) return memo.value;
  const value = (await env.KV.get(`c:ver:${ns}`)) ?? '0';
  versionMemo.set(ns, { value, at: Date.now() });
  return value;
}

/** Make every cached entry of `ns` stale (call after writing the source rows). */
export async function invalidate(env: Env, ns: CacheNamespace): Promise<void> {
  const value = Date.now().toString(36);
  versionMemo.set(ns, { value, at: Date.now() });
  await env.KV.put(`c:ver:${ns}`, value);
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
