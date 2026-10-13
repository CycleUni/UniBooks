import type { Env } from '../env';

/**
 * Stored images (listing photos, chat images, ad images): the types we
 * accept, how their bytes are checked, and how R2 keys map to public URLs.
 * Each feature chooses its own key prefix; everything else is shared.
 */

export type ImageExt = 'jpg' | 'png' | 'webp' | 'gif';

/** Accepted Content-Type → extension. */
export const IMAGE_TYPES: Record<string, ImageExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Extension → the Content-Type it is stored with. */
export const IMAGE_CONTENT_TYPES: Record<ImageExt, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Largest image accepted anywhere. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The image type the bytes actually are, from their magic numbers, or null.
 * Never trust a declared Content-Type or file name: an HTML or SVG body
 * labelled image/png would be served back from the media host.
 */
export function sniffImage(bytes: Uint8Array): ImageExt | null {
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

/** A declared upload size: an integer in 1..max, else null. */
export function validatedContentLength(raw: unknown, max = MAX_IMAGE_BYTES): number | null {
  if (typeof raw === 'boolean') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > max) return null;
  return n;
}

/** A fresh server-chosen object name: `<32 hex>.<ext>`. */
export function newObjectName(ext: ImageExt): string {
  return `${crypto.randomUUID().replaceAll('-', '')}.${ext}`;
}

/**
 * Where public image URLs live: R2_PUBLIC_URL, or the Worker's own media
 * route (/api/media, index.ts) in local development when no public bucket
 * domain is configured.
 */
export function publicBase(env: Env, origin: string): string {
  return (env.R2_PUBLIC_URL || `${origin}/api/media`).replace(/\/+$/, '');
}

export function publicUrl(env: Env, origin: string, key: string): string {
  return `${publicBase(env, origin)}/${key}`;
}

export type KeyResult = { key: string } | { error: 'invalid' | 'host' };

/**
 * The storage key behind a URL we issued, or why not. The host must be the
 * public bucket domain (any other host: 'host'); the path is decoded before
 * the checks so %2e%2e or %2f cannot slip past them. Callers delete what
 * this returns, so it never derives a key from a foreign URL.
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

/** storageKeyFromUrl for callers that only need the key or nothing. */
export function storageKey(env: Env, origin: string, url: unknown): string | null {
  const r = storageKeyFromUrl(env, origin, url);
  return 'key' in r ? r.key : null;
}
