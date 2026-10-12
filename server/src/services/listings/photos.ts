/**
 * Listing photo storage: upload keys, magic-byte sniffing, URL → key
 * resolution, tmp → permanent promotion and fail-closed deletion
 *
 * Keys are chosen by the server and carry the uploader's id:
 *   tmp/listings/<userId>/<hex>.<ext>   pending (R2 lifecycle reaps tmp/)
 *   listings/<userId>/<hex>.<ext>       attached to a listing
 * A client-supplied photo is accepted only if it resolves to one of those
 * keys under the caller's own id (tmp) or is already on the listing being
 * edited (permanent). Nothing else is ever adopted, copied or deleted.
 */
import { sql } from 'drizzle-orm';
import type { Env } from '../../env';
import { createDb, listings } from '../../db';

export const TMP_LISTING_PREFIX = 'tmp/listings';
export const PERMANENT_LISTING_PREFIX = 'listings';
export const MAX_LISTING_PHOTOS = 6;
export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;

/** Declared Content-Type → extension: gif is allowed for listings. */
export const ALLOWED_CONTENT_TYPES: Record<string, 'jpg' | 'png' | 'webp' | 'gif'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
export const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const tmpKeyPrefix = (userId: string) => `${TMP_LISTING_PREFIX}/${userId}/`;
export const permanentKeyPrefix = (userId: string) => `${PERMANENT_LISTING_PREFIX}/${userId}/`;

/** Server-issued object names only: <hex>.<ext>. */
const NAME_RE = /^[0-9a-f]{32}\.(?:jpg|png|webp|gif)$/;

/** The image type the bytes actually are (magic numbers), or null. */
export function detectImageExtension(bytes: Uint8Array): 'jpg' | 'png' | 'webp' | 'gif' | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'png';
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'gif';
  return null;
}

/**
 * The client's declared upload size, or null when unusable: an integer in 1..MAX_UPLOAD_SIZE_BYTES.
 */
export function validatedContentLength(raw: unknown): number | null {
  if (typeof raw === 'boolean' || raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_UPLOAD_SIZE_BYTES) return null;
  return n;
}

/**
 * Where public photo URLs live: R2_PUBLIC_URL, or the Worker's own /media in
 * local development when no public bucket domain is configured.
 */
export function publicBase(env: Env, origin: string): string {
  return (env.R2_PUBLIC_URL || `${origin}/media`).replace(/\/+$/, '');
}

export const publicUrlFor = (env: Env, origin: string, key: string) => `${publicBase(env, origin)}/${key}`;

export type KeyResult = { key: string } | { error: 'invalid' | 'host' };

/**
 * The storage key behind a URL we issued, or why not. Host must be the
 * public bucket domain (any other host: 'host'); the path is decoded before
 * the checks so %2e%2e or %2f cannot slip past them.
 */
export function storageKeyFromUrl(env: Env, origin: string, url: unknown): KeyResult {
  if (typeof url !== 'string' || !url) return { error: 'invalid' };
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(publicBase(env, origin));
  } catch {
    return { error: 'invalid' };
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return { error: 'invalid' };
  if (parsed.host.toLowerCase() !== base.host.toLowerCase()) return { error: 'host' };
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return { error: 'invalid' };
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return { error: 'invalid' };
  }
  const basePath = base.pathname.replace(/\/+$/, '') + '/';
  if (!path.startsWith(basePath)) return { error: 'invalid' };
  const key = path.slice(basePath.length);
  const parts = key.split('/');
  if (!key || key.includes('\\') || parts.some((p) => p === '' || p === '.' || p === '..')) return { error: 'invalid' };
  return { key };
}

export class PhotoError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/**
 * Validate a listing's `photos` and promote this user's pending uploads to
 * permanent keys; returns the URLs to store. `kept` are the listing's current
 * photos (an update may send them back unchanged). Throws PhotoError with
 * one of the codes listing.errInvalidPhotos / errTooManyPhotos /
 * errPhotoHostNotAllowed / errPhotoNotOwned / errPhotoPromoteFailed.
 */
export async function acceptListingPhotos(
  env: Env,
  origin: string,
  photos: unknown,
  userId: string,
  kept: string[] = [],
): Promise<string[]> {
  if (!Array.isArray(photos)) throw new PhotoError('listing.errInvalidPhotos');
  if (photos.length > MAX_LISTING_PHOTOS) throw new PhotoError('listing.errTooManyPhotos');

  // Validate every entry before touching storage.
  const plan: Array<{ url: string; promote?: { from: string; to: string } }> = [];
  for (const url of photos) {
    if (typeof url !== 'string') throw new PhotoError('listing.errInvalidPhotos');
    const res = storageKeyFromUrl(env, origin, url);
    if ('error' in res) {
      throw new PhotoError(res.error === 'host' ? 'listing.errPhotoHostNotAllowed' : 'listing.errInvalidPhotos');
    }
    const { key } = res;
    if (key.startsWith(`${TMP_LISTING_PREFIX}/`)) {
      const rest = key.slice(tmpKeyPrefix(userId).length);
      if (!key.startsWith(tmpKeyPrefix(userId)) || !NAME_RE.test(rest)) {
        throw new PhotoError('listing.errPhotoNotOwned');
      }
      plan.push({ url, promote: { from: key, to: `${permanentKeyPrefix(userId)}${rest}` } });
      continue;
    }
    if (!kept.includes(url)) throw new PhotoError('listing.errPhotoNotOwned');
    plan.push({ url });
  }
  if (new Set(plan.map((p) => p.url)).size !== plan.length) throw new PhotoError('listing.errInvalidPhotos');

  const out: string[] = [];
  for (const item of plan) {
    if (!item.promote) {
      out.push(item.url);
      continue;
    }
    try {
      const obj = await env.R2.get(item.promote.from);
      if (!obj) throw new Error('missing');
      const ext = item.promote.to.split('.').pop() ?? '';
      await env.R2.put(item.promote.to, await obj.arrayBuffer(), {
        httpMetadata: { contentType: CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream' },
      });
      await env.R2.delete(item.promote.from);
    } catch (e) {
      console.error('[listings] failed to promote tmp photo', item.promote.from, e);
      throw new PhotoError('listing.errPhotoPromoteFailed');
    }
    out.push(publicUrlFor(env, origin, item.promote.to));
  }
  return out;
}

/** Listings (id, seller) whose photos hold exactly `url`. */
export async function listingsHoldingPhoto(env: Env, url: string): Promise<Array<{ id: string; sellerId: string }>> {
  const rows = await createDb(env.DB)
    .select({ id: listings.id, sellerId: listings.sellerId, photos: listings.photos })
    .from(listings)
    .where(sql`instr(${listings.photos}, ${url}) > 0`);
  return rows
    .filter((r) => {
      try {
        const v = JSON.parse(r.photos);
        return Array.isArray(v) && v.includes(url);
      } catch {
        return false;
      }
    })
    .map(({ id, sellerId }) => ({ id, sellerId }));
}

/**
 * Remove a deleted listing's photos from R2 — only keys under the seller's own
 * listing prefix, and only when no
 * other listing still shows the photo. Failures are logged, never raised.
 */
export async function deleteListingPhotos(env: Env, origin: string, sellerId: string, urls: string[]): Promise<void> {
  for (const url of urls) {
    try {
      const res = storageKeyFromUrl(env, origin, url);
      if ('error' in res) continue;
      const { key } = res;
      if (!key.startsWith(permanentKeyPrefix(sellerId))) {
        console.warn('[listings] skipped non-listing key on delete', key);
        continue;
      }
      if ((await listingsHoldingPhoto(env, url)).length) continue;
      await env.R2.delete(key);
    } catch (e) {
      console.warn('[listings] failed to delete photo', url, e);
    }
  }
}
