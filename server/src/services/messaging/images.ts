/**
 * Chat image uploads: GIF allowed.
 */

/** Declared Content-Type → extension. Chat accepts GIF; listings do not. */
export const CHAT_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Maximum chat image size. */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The image type the bytes actually are, from their magic numbers, or null.
 * Never trust a declared Content-Type or file name: an HTML or SVG body
 * labelled image/png would be served back from the media host.
 */
export function sniffImageType(bytes: Uint8Array): keyof typeof CHAT_IMAGE_TYPES | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
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
    return 'image/png';
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // RIFF
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  if (
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 && // GIF8
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61 // 7a / 9a
  ) {
    return 'image/gif';
  }
  return null;
}

/** A positive int within the limit, or null. */
export function validatedContentLength(raw: unknown, max = MAX_CHAT_IMAGE_BYTES): number | null {
  if (typeof raw === 'boolean') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > max) return null;
  return n;
}

/** The R2 key for a new chat image: `chat/<userId>/<uuid>.<ext>` (contract rule 7). */
export function chatImageKey(userId: string, contentType: string): string {
  return `chat/${userId}/${crypto.randomUUID().replace(/-/g, '')}.${CHAT_IMAGE_TYPES[contentType]}`;
}

/** Public URL of an R2 key: `${R2_PUBLIC_URL}/${key}`. */
export function publicUrl(r2PublicUrl: string | undefined, key: string): string {
  return `${(r2PublicUrl ?? '').replace(/\/+$/, '')}/${key}`;
}

/**
 * Whether an image message's URL points at a chat upload on our own media
 * host. On top of the host allowlist (imageUrlPolicy), when R2_PUBLIC_URL is
 * configured the URL must sit under its `chat/` prefix — an image message can
 * only show something the chat upload endpoints issued.
 */
export function isChatImageUrl(rawUrl: string, r2PublicUrl: string | undefined): boolean {
  if (!r2PublicUrl) return true;
  let url: URL;
  let base: URL;
  try {
    url = new URL(rawUrl);
    base = new URL(r2PublicUrl.replace(/\/+$/, '') + '/');
  } catch {
    return false;
  }
  if (url.origin !== base.origin) return false;
  if (url.search || url.hash) return false;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (path.includes('..') || path.includes('\\')) return false;
  return path.startsWith(`${base.pathname}chat/`);
}
