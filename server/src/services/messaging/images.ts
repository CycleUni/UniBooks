/**
 * Chat image uploads. Types, sniffing and URLs are shared (lib/media.ts);
 * what is chat-specific is where they are stored and which URLs an image
 * message may show.
 */

/** The uploader's folder for chat images: `chat/<userId>/` (contract rule 7). */
export const chatImagePrefix = (userId: string) => `chat/${userId}/`;

/**
 * Whether an image message's URL points at a chat upload on our own media
 * host. On top of the host allowlist (imageUrlPolicy), when R2_PUBLIC_URL is
 * configured the URL must sit under its `chat/` prefix — an image message can
 * only show something the chat upload endpoints issued — and, given
 * `ownerId`, under that user's own folder: a sender posts their own uploads,
 * not someone else's.
 */
export function isChatImageUrl(rawUrl: string, r2PublicUrl: string | undefined, ownerId?: string): boolean {
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
  return path.startsWith(ownerId === undefined ? `${base.pathname}chat/` : `${base.pathname}${chatImagePrefix(ownerId)}`);
}
