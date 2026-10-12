/**
 * A tiny versioned KV cache. A "version key" names a family of entries
 * (e.g. `ads:ver` for everything derived from the ads database); bumping it
 * makes every entry built under the old version unreachable at once, so a
 * write shows up immediately instead of when the TTL runs out. Old entries
 * simply expire.
 *
 * KV failures never fail the request: a miss just recomputes.
 */

/** KV's minimum expirationTtl. */
const MIN_TTL = 60;

export const ADS_VERSION_KEY = 'ads:ver';

/** The current version of `versionKey` ('0' before the first bump). */
export async function cacheVersion(kv: KVNamespace, versionKey: string): Promise<string> {
  try {
    return (await kv.get(versionKey)) ?? '0';
  } catch {
    return '0';
  }
}

/** Invalidate every entry built under `versionKey`. */
export async function bumpVersion(kv: KVNamespace, versionKey: string): Promise<void> {
  try {
    await kv.put(versionKey, `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`);
  } catch {
    // A failed bump leaves at most TTL-old entries; never fail the write for it.
  }
}

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

/** `${prefix}:${version}:${parts...}` with the version read from `versionKey`. */
export async function versionedKey(kv: KVNamespace, versionKey: string, prefix: string, parts: (string | number)[]): Promise<string> {
  const ver = await cacheVersion(kv, versionKey);
  return [prefix, ver, ...parts.map((p) => encodeURIComponent(String(p)))].join(':');
}
