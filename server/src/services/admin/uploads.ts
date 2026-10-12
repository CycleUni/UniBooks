import type { Env } from '../../env';

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

/** Allowed content types: ad images may also be GIFs. */
export const AD_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const EXT_TO_TYPE: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** Maximum upload size. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const TMP_AD_PREFIX = 'tmp/ads';
export const AD_PREFIX = 'ads';

/** The image type the bytes actually are (jpg/png/webp/gif), or null. */
export function sniffImage(bytes: Uint8Array): 'jpg' | 'png' | 'webp' | 'gif' | null {
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

export function contentTypeForExt(ext: string): string {
  return EXT_TO_TYPE[ext];
}

/** A positive int up to the limit, else null. */
export function validatedContentLength(raw: unknown, max = MAX_UPLOAD_BYTES): number | null {
  if (typeof raw === 'boolean') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > max) return null;
  return n;
}

export function tmpAdKey(userId: string, ext: string): string {
  return `${TMP_AD_PREFIX}/${userId}/${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
}

/**
 * Public base for stored objects: R2's public domain in production, this
 * Worker's own /media/ route in local development (index.ts).
 */
function publicBase(env: Env, origin: string): string {
  return env.R2_PUBLIC_URL ? env.R2_PUBLIC_URL.replace(/\/+$/, '') : `${origin}/media`;
}

export function publicUrl(env: Env, origin: string, key: string): string {
  return `${publicBase(env, origin)}/${key}`;
}

/**
 * The key for a URL we ourselves issued, or
 * null when the URL does not demonstrably point at our storage. Never derive
 * a key from a foreign host — callers delete what this returns.
 */
export function storageKeyFromUrl(env: Env, origin: string, url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  const base = publicBase(env, origin);
  let parsed: URL;
  let baseUrl: URL;
  try {
    parsed = new URL(url);
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.host.toLowerCase() !== baseUrl.host.toLowerCase()) return null;
  if (parsed.search || parsed.hash) return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  if (basePath) {
    if (!path.startsWith(`${basePath}/`)) return null;
    path = path.slice(basePath.length + 1);
  } else {
    path = path.replace(/^\/+/, '');
  }
  if (!path || path.includes('\\') || path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  return path;
}

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
    return { ok: true, url, key: storageKeyFromUrl(env, origin, url) ?? '', promoted: false };
  }
  const key = storageKeyFromUrl(env, origin, url);
  if (!key) return { ok: false, code: 'listing.errPhotoHostNotAllowed' };
  const tmp = TMP_RE.exec(key);
  if (!tmp) return { ok: false, code: 'listing.errPhotoNotOwned' };
  if (tmp[1] !== userId) return { ok: false, code: 'listing.errPhotoNotOwned' };

  const newKey = `${AD_PREFIX}/${userId}/${tmp[2]}`;
  const obj = await env.R2.get(key);
  if (!obj) return { ok: false, code: 'admin.errUploadFailed' };
  const ext = tmp[2].split('.').pop()!;
  await env.R2.put(newKey, obj.body, { httpMetadata: { contentType: contentTypeForExt(ext) } });
  await env.R2.delete(key);
  return { ok: true, url: publicUrl(env, origin, newKey), key: newKey, promoted: true };
}

/** Delete an ad's stored image — only ever a key under ads/ or tmp/ads/. */
export async function deleteAdImage(env: Env, origin: string, url: string | null | undefined): Promise<void> {
  if (!url) return;
  const key = storageKeyFromUrl(env, origin, url);
  if (!key || !(PERM_RE.test(key) || TMP_RE.test(key))) return;
  try {
    await env.R2.delete(key);
  } catch (e) {
    console.error('[admin] failed to delete ad image', key, e);
  }
}

/** Whether `url` points at an image we store. */
export function isInternalImage(env: Env, origin: string, url: string | null | undefined): boolean {
  return !!url && !!storageKeyFromUrl(env, origin, url);
}
