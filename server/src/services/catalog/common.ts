/**
 * Small catalogue helpers shared by books, search, listings and subscriptions
 */

const WRAPPING_QUOTES: Array<[string, string]> = [
  ['"', '"'],
  ['“', '”'],
];

/**
 * A publisher name without quotation marks wrapping the whole value (Google
 * Books sends `"O'Reilly Media, Inc."` quotes included). `"A" & "B"` stays.
 */
export function cleanPublisher<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  for (const [open, close] of WRAPPING_QUOTES) {
    const inner = text.slice(open.length, text.length - close.length);
    if (
      text.length > open.length + close.length &&
      text.startsWith(open) &&
      text.endsWith(close) &&
      !inner.includes(open) &&
      !inner.includes(close)
    ) {
      return inner.trim();
    }
  }
  return text;
}

/** Book.cover_url's max length. */
export const COVER_URL_MAX = 1024;

/**
 * The cover URL to store: stripped, '' when blank, null when unusable (not a
 * string, too long, or not an http(s) URL with a real host).
 */
export function cleanCoverUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return '';
  if (v.length > COVER_URL_MAX) return null;
  if (/\s/.test(v)) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (!host || (!host.includes('.') && host !== 'localhost')) return null;
  return v;
}

/** Where catalogue covers come from; the cover proxy (services/frontend/cover.ts) fetches only these. */
export const COVER_PROXY_HOSTS: readonly string[] = ['books.google.com', 'covers.openlibrary.org', 'pdsapp.ncl.edu.tw'];

/**
 * Whether a cleaned cover URL is one a non-admin may store: a catalogue cover
 * host, or this deployment's own public media (`mediaBase`, lib/media.ts
 * publicBase). Anything else would have every reader's browser fetch from a
 * host the seller picked.
 */
export function isTrustedCoverUrl(url: string, mediaBase: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (COVER_PROXY_HOSTS.includes(parsed.hostname)) return true;
  return parsed.href.startsWith(`${mediaBase.replace(/\/+$/, '')}/`);
}

export type Engine = 'googlebooks' | 'openlibrary' | 'isbnnet';

/** Provenance label for developer monitoring (not shown in the UI). */
export function describeSource(engine: Engine | null, cacheHit: boolean): string {
  const label = engine === 'googlebooks' ? 'google books' : engine === 'isbnnet' ? 'ISBNnet' : 'Open Library API';
  return cacheHit ? `${label} cache` : label;
}
