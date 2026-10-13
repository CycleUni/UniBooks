import type { Env } from '../../env';
import { IMAGE_CONTENT_TYPES, publicUrl, storageKey, type ImageExt } from '../../lib/media';

/**
 * Ad image storage, contract rule 7.
 *
 * The server decides every key: an upload lands at
 *   tmp/ads/<userId>/<uuid>.<ext>
 * and saving an ad promotes it to
 *   ads/<userId>/<uuid>.<ext>
 * (tmp/ is reaped by an R2 lifecycle rule, so promotion must never fail
 * silently). The stored Content-Type is the one the magic bytes prove, never
 * the client's.
 */

export const TMP_AD_PREFIX = 'tmp/ads';
export const AD_PREFIX = 'ads';

/** The uploader's folder for pending ad images: `tmp/ads/<userId>/`. */
export const tmpAdPrefix = (userId: string) => `${TMP_AD_PREFIX}/${userId}/`;

const TMP_RE = /^tmp\/ads\/([^/]+)\/([0-9a-f]{32}\.(?:jpg|png|webp|gif))$/;
const PERM_RE = /^ads\/([^/]+)\/([0-9a-f]{32}\.(?:jpg|png|webp|gif))$/;

export type AdImageResolution =
  | { ok: true; url: string; key: string; promoted: boolean }
  | { ok: false; code: 'listing.errPhotoHostNotAllowed' | 'listing.errPhotoNotOwned' | 'admin.errUploadFailed' };

/**
 * Promote one image: the URL must be one
 * of our own keys, and either an upload of *this* user under tmp/ads/ (moved
 * to ads/ here) or `current` — the ad's existing image, kept as is.
 */
export async function resolveAdImage(
  env: Env,
  origin: string,
  userId: string,
  url: string,
  current: string | null,
): Promise<AdImageResolution> {
  if (current && url === current) {
    return { ok: true, url, key: storageKey(env, origin, url) ?? '', promoted: false };
  }
  const key = storageKey(env, origin, url);
  if (!key) return { ok: false, code: 'listing.errPhotoHostNotAllowed' };
  const tmp = TMP_RE.exec(key);
  if (!tmp) return { ok: false, code: 'listing.errPhotoNotOwned' };
  if (tmp[1] !== userId) return { ok: false, code: 'listing.errPhotoNotOwned' };

  const newKey = `${AD_PREFIX}/${userId}/${tmp[2]}`;
  const obj = await env.R2.get(key);
  if (!obj) return { ok: false, code: 'admin.errUploadFailed' };
  const ext = tmp[2].split('.').pop()!;
  await env.R2.put(newKey, obj.body, { httpMetadata: { contentType: IMAGE_CONTENT_TYPES[ext as ImageExt] } });
  await env.R2.delete(key);
  return { ok: true, url: publicUrl(env, origin, newKey), key: newKey, promoted: true };
}

/** Delete an ad's stored image — only ever a key under ads/ or tmp/ads/. */
export async function deleteAdImage(env: Env, origin: string, url: string | null | undefined): Promise<void> {
  if (!url) return;
  const key = storageKey(env, origin, url);
  if (!key || !(PERM_RE.test(key) || TMP_RE.test(key))) return;
  try {
    await env.R2.delete(key);
  } catch (e) {
    console.error('[admin] failed to delete ad image', key, e);
  }
}

/** Whether `url` points at an image we store. */
export function isInternalImage(env: Env, origin: string, url: string | null | undefined): boolean {
  return !!url && !!storageKey(env, origin, url);
}
