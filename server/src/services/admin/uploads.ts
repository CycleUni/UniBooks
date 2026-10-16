import type { Env } from '../../env';
import { readCapped } from '../../lib/body';
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES, newObjectName, publicUrl, sniffImage, storageKey, type ImageExt } from '../../lib/media';

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
  | {
      ok: false;
      code: 'listing.errPhotoHostNotAllowed' | 'listing.errPhotoNotOwned' | 'admin.errUploadFailed' | 'admin.errImageFetchFailed';
    };

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
  fetchImpl: typeof fetch = fetch,
): Promise<AdImageResolution> {
  if (current && url === current) {
    return { ok: true, url, key: storageKey(env, origin, url) ?? '', promoted: false };
  }
  const key = storageKey(env, origin, url);
  if (!key) return importExternalAdImage(env, origin, userId, url, fetchImpl);
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

const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

/**
 * A host we will fetch from: a DNS name, never an IP literal, localhost or an
 * internal suffix. Workers cannot reach private ranges anyway; this keeps the
 * request off them by construction.
 */
function isFetchableHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes('.') || h.startsWith('[') || /^[\d.]+$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|localdomain|lan|home|corp)$/.test(h);
}

function parseFetchableUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  return isFetchableHost(u.hostname) ? u : null;
}

type ExternalImage =
  { ok: true; bytes: Uint8Array; ext: ImageExt } | { ok: false; code: 'listing.errPhotoHostNotAllowed' | 'admin.errImageFetchFailed' };

/**
 * Fetch an image from a foreign https URL: magic-byte type, size cap, and
 * redirects followed by hand so every hop is re-validated.
 */
async function fetchExternalImage(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<ExternalImage> {
  const first = parseFetchableUrl(rawUrl);
  if (!first) return { ok: false, code: 'listing.errPhotoHostNotAllowed' };
  const fail = { ok: false, code: 'admin.errImageFetchFailed' } as const;
  try {
    let target: URL = first;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetchImpl(target.href, {
        redirect: 'manual',
        headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get('Location');
      await res.body?.cancel().catch(() => {});
      const next: URL | null = loc ? parseFetchableUrl(new URL(loc, target).href) : null;
      if (!next || hop === MAX_REDIRECTS) return fail;
      target = next;
      res = null;
    }
    if (!res || !res.ok) return fail;
    const bytes = await readCapped(res, MAX_IMAGE_BYTES);
    const ext = bytes && sniffImage(bytes);
    if (!bytes || !ext || !bytes.length) return fail;
    return { ok: true, bytes, ext };
  } catch {
    return fail;
  }
}

/**
 * An ad image given as a foreign https URL, fetched when the ad is saved and
 * stored under ads/<userId>/ like an upload, so the saved ad only ever points
 * at our own media host (and the CSP's img-src stays narrow).
 */
async function importExternalAdImage(
  env: Env,
  origin: string,
  userId: string,
  rawUrl: string,
  fetchImpl: typeof fetch,
): Promise<AdImageResolution> {
  const img = await fetchExternalImage(rawUrl, fetchImpl);
  if (!img.ok) return img;
  const key = `${AD_PREFIX}/${userId}/${newObjectName(img.ext)}`;
  await env.R2.put(key, img.bytes, { httpMetadata: { contentType: IMAGE_CONTENT_TYPES[img.ext] } });
  return { ok: true, url: publicUrl(env, origin, key), key, promoted: true };
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
