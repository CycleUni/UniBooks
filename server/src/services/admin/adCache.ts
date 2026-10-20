/**
 * KV read-through for the public ad list, keyed under the `ads` cache
 * version (lib/cache.ts): an ad or advertiser write invalidates the
 * namespace, every entry built under the old version becomes unreachable at
 * once, and old entries simply expire.
 *
 * KV failures never fail the request: a miss just recomputes.
 */
import type { Env } from '../../env';
import { currentVersion, type CacheNamespace } from '../../lib/cache';

/** KV's minimum expirationTtl. */
const MIN_TTL = 60;

/**
 * JSON read-through cache. `key` should already include the version
 * (see versionedKey). `load` returning undefined is not cached.
 */
export async function cachedJson<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T | undefined>,
): Promise<T | undefined> {
  try {
    const hit = await kv.get<T>(key, 'json');
    if (hit !== null) return hit;
  } catch {
    // fall through to load
  }
  const value = await load();
  if (value !== undefined) {
    try {
      await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(MIN_TTL, ttlSeconds) });
    } catch {
      // uncached is fine
    }
  }
  return value;
}

/** `${prefix}:${version}:${parts...}` with `ns`'s current version. */
export async function versionedKey(env: Env, ns: CacheNamespace, prefix: string, parts: (string | number)[]): Promise<string> {
  const ver = await currentVersion(env, ns);
  return [prefix, ver, ...parts.map((p) => encodeURIComponent(String(p)))].join(':');
}
