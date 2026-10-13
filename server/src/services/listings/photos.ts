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
import { IMAGE_CONTENT_TYPES, publicUrl, storageKeyFromUrl, type ImageExt } from '../../lib/media';

export const TMP_LISTING_PREFIX = 'tmp/listings';
export const PERMANENT_LISTING_PREFIX = 'listings';
export const MAX_LISTING_PHOTOS = 6;
export const tmpKeyPrefix = (userId: string) => `${TMP_LISTING_PREFIX}/${userId}/`;
export const permanentKeyPrefix = (userId: string) => `${PERMANENT_LISTING_PREFIX}/${userId}/`;

/** Server-issued object names only: <hex>.<ext>. */
const NAME_RE = /^[0-9a-f]{32}\.(?:jpg|png|webp|gif)$/;

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
): Promise<AcceptedPhotos> {
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

  const out: AcceptedPhotos = { urls: [], tmpKeys: [], promoted: [] };
  for (const item of plan) {
    if (!item.promote) {
      out.urls.push(item.url);
      continue;
    }
    try {
      const obj = await env.R2.get(item.promote.from);
      if (!obj) throw new Error('missing');
      const ext = item.promote.to.split('.').pop() ?? '';
      await env.R2.put(item.promote.to, await obj.arrayBuffer(), {
        httpMetadata: { contentType: IMAGE_CONTENT_TYPES[ext as ImageExt] ?? 'application/octet-stream' },
      });
    } catch (e) {
      console.error('[listings] failed to promote tmp photo', item.promote.from, e);
      throw new PhotoError('listing.errPhotoPromoteFailed');
    }
    const promotedUrl = publicUrl(env, origin, item.promote.to);
    out.urls.push(promotedUrl);
    out.tmpKeys.push(item.promote.from);
    out.promoted.push(promotedUrl);
  }
  return out;
}

/**
 * The photos a listing write will store. Uploads are copied to permanent
 * keys but their tmp/ originals are kept until the write commits, so a
 * write that fails (an order accepted meanwhile) can simply be retried.
 */
export interface AcceptedPhotos {
  urls: string[];
  /** tmp/ originals of the promoted photos. */
  tmpKeys: string[];
  /** Permanent copies made for this write. */
  promoted: string[];
}

/**
 * After the listing write: committed, the tmp/ originals go, and so do the
 * photos the write `dropped` from the listing (else they stay public at
 * their URL). Not committed, the copies made for it go and the uploads stay.
 * Storage bookkeeping only: failures are logged, never thrown.
 */
export async function settlePhotos(
  env: Env,
  origin: string,
  sellerId: string,
  accepted: AcceptedPhotos,
  committed: boolean,
  dropped: string[] = [],
): Promise<void> {
  if (!committed) return deleteListingPhotos(env, origin, sellerId, accepted.promoted);
  for (const key of accepted.tmpKeys) {
    await env.R2.delete(key).catch((e: unknown) => console.warn('[listings] failed to delete tmp photo', key, e));
  }
  await deleteListingPhotos(env, origin, sellerId, dropped);
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
