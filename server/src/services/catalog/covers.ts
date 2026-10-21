import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Env } from '../../env';
import { books, createDb, listings, type Book } from '../../db';
import { IMAGE_CONTENT_TYPES, IMAGE_TYPES, publicUrl, sniffImage } from '../../lib/media';
import { siteOrigin } from '../../lib/origin';
import { inList } from '../../lib/sql';
import { fetchAndValidateCover, UpstreamError } from '../frontend/cover';

/** Statuses considered "listed" — only books with at least one such listing get an R2 copy. */
export const LISTED_STATUSES = ['active', 'reserved'] as const;

/** 7 days retry cooldown for books whose upstream cover was missing or a placeholder. */
export const COVER_RETRY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Books copied per cron run. Each copy may ask upstream up to three times
 * (Google's zoom 3, 2, 1), and the free plan allows 50 external subrequests
 * per invocation: 10 books stay at 30 or fewer.
 */
export const COVER_SWEEP_BATCH_SIZE = 10;
export const COVER_CLEANUP_BATCH_SIZE = 50;

/** Upstream cover hosts get this long before timing out during a copy attempt. */
const COVER_FETCH_TIMEOUT_MS = 8000;

export type BookCoverSource =
  { coverUrl?: string | null; coverR2Key?: string | null } | { cover_url?: string | null; cover_r2_key?: string | null } | null | undefined;

/**
 * Returns the public cover URL for a book:
 * - The R2 public URL (served from R2_PUBLIC_URL / media route) when cover_r2_key is present.
 * - Otherwise the original external cover_url as today.
 */
export function coverUrlFor(env: Env, origin: string | undefined, book: BookCoverSource): string {
  if (!book) return '';
  const r2Key = 'coverR2Key' in book ? book.coverR2Key : 'cover_r2_key' in book ? book.cover_r2_key : undefined;
  if (r2Key) {
    const o = origin || siteOrigin(env);
    return publicUrl(env, o, r2Key);
  }
  const orig = 'coverUrl' in book ? book.coverUrl : 'cover_url' in book ? book.cover_url : '';
  return orig ?? '';
}

/** Whether a book currently has at least one listing with status 'active' or 'reserved'. */
export async function isBookListed(env: Env, bookId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.bookId, bookId), inArray(listings.status, LISTED_STATUSES)))
    .limit(1);
  return !!row;
}

export interface CopyCoverOptions {
  fetch?: (url: string) => Promise<Response>;
  force?: boolean;
}

/**
 * Copies a listed book's cover to R2 under `covers/<bookId>.<ext>` if not already stored.
 * Checks that the book is currently listed (status active or reserved), respects the
 * 7-day retry cooldown for missing covers, and runs zoom cascade 3→2→1 for Google Books.
 */
export async function copyBookCover(env: Env, origin: string, bookId: string, options: CopyCoverOptions = {}): Promise<boolean> {
  const db = createDb(env.DB);
  const [book] = await db
    .select({
      id: books.id,
      coverUrl: books.coverUrl,
      coverR2Key: books.coverR2Key,
      coverCheckedAt: books.coverCheckedAt,
    })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  if (!book) return false;

  // Requirement 1: Only books that have at least one listing with status active or reserved get an R2 copy.
  const listed = await isBookListed(env, book.id);
  if (!listed) return false;

  if (book.coverR2Key && !options.force) {
    return true;
  }

  const now = new Date();
  const nowIso = now.toISOString();

  if (!book.coverUrl) {
    await db.update(books).set({ coverCheckedAt: nowIso }).where(eq(books.id, book.id));
    return false;
  }

  // Requirement 5: Do not retry before the interval (7 days)
  if (book.coverCheckedAt && !options.force) {
    const elapsed = now.getTime() - new Date(book.coverCheckedAt).getTime();
    if (elapsed < COVER_RETRY_INTERVAL_MS) {
      return false;
    }
  }

  const fetcher = options.fetch ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS) }));

  let validated;
  try {
    validated = await fetchAndValidateCover(book.coverUrl, fetcher, { startZoom: 3 });
  } catch (e) {
    if (e instanceof UpstreamError) {
      // Transient failure (network/5xx) — do not record as missing so it can be retried without waiting 7 days.
      console.warn(`[covers] transient upstream failure for book ${book.id}:`, e);
      return false;
    }
    throw e;
  }

  if (!validated) {
    // Upstream has no real cover (placeholder / 404 / unsupported / degenerate). Record check timestamp.
    await db.update(books).set({ coverCheckedAt: nowIso }).where(eq(books.id, book.id));
    return false;
  }

  const { bytes, contentType } = validated;
  const ext = sniffImage(bytes) || (IMAGE_TYPES[contentType.toLowerCase()] ?? 'jpg');
  const finalContentType = IMAGE_CONTENT_TYPES[ext] ?? contentType;
  // The source URL's hash is part of the key: a changed cover is a new URL,
  // so no browser or edge copy of the old picture is ever served for it, and
  // the object can be cached for good.
  const key = `covers/${book.id}-${(await sha1Hex(book.coverUrl)).slice(0, 10)}.${ext}`;

  await env.R2.put(key, bytes, {
    httpMetadata: { contentType: finalContentType, cacheControl: 'public, max-age=31536000, immutable' },
  });

  // Re-verify listed status before persisting in D1: a concurrent listing deletion or status change
  // must not leave an orphaned R2 cover for an unlisted book.
  const stillListed = await isBookListed(env, book.id);
  if (!stillListed) {
    await env.R2.delete(key).catch((e: unknown) => console.error(`[covers] rollback delete failed for ${key}`, e));
    return false;
  }

  await db
    .update(books)
    .set({
      coverR2Key: key,
      coverCheckedAt: nowIso,
    })
    .where(eq(books.id, book.id));

  return true;
}

/**
 * Drops an existing R2 cover copy for a book (e.g. when cover_url changes)
 * and clears the column on the book record.
 */
export async function dropCoverCopy(env: Env, book: string | Pick<Book, 'id' | 'coverR2Key'>): Promise<void> {
  const db = createDb(env.DB);
  let id: string;
  let key: string | null = null;

  if (typeof book === 'string') {
    id = book;
    const [row] = await db.select({ coverR2Key: books.coverR2Key }).from(books).where(eq(books.id, id)).limit(1);
    key = row?.coverR2Key ?? null;
  } else {
    id = book.id;
    key = book.coverR2Key ?? null;
  }

  if (key && key.startsWith('covers/')) {
    await env.R2.delete(key).catch((e: unknown) => console.error(`[covers] failed to delete ${key}`, e));
  }

  await db.update(books).set({ coverR2Key: null, coverCheckedAt: null }).where(eq(books.id, id));
}

export interface SweepResult {
  scanned: number;
  copied: number;
}

/**
 * Cron sweep: copies listed books still missing an R2 copy, bounded batch per run, oldest first.
 */
export async function runCoverSweep(
  env: Env,
  batchSize = COVER_SWEEP_BATCH_SIZE,
  fetchFn?: (url: string) => Promise<Response>,
): Promise<SweepResult> {
  const db = createDb(env.DB);
  const cutoff = new Date(Date.now() - COVER_RETRY_INTERVAL_MS).toISOString();

  // Listed books missing a copy, whose retry interval has passed or never checked, oldest first
  const rows = await db
    .select({
      id: books.id,
      coverUrl: books.coverUrl,
      coverR2Key: books.coverR2Key,
      coverCheckedAt: books.coverCheckedAt,
      createdAt: books.createdAt,
    })
    .from(books)
    .where(
      and(
        isNull(books.coverR2Key),
        ne(books.coverUrl, ''),
        or(isNull(books.coverCheckedAt), lte(books.coverCheckedAt, cutoff)),
        sql`EXISTS (SELECT 1 FROM listings l WHERE l.book_id = ${books.id} AND l.status IN ('active', 'reserved'))`,
      ),
    )
    .orderBy(asc(books.createdAt))
    .limit(batchSize);

  let copied = 0;
  for (const b of rows) {
    try {
      const ok = await copyBookCover(env, siteOrigin(env), b.id, { fetch: fetchFn });
      if (ok) copied++;
    } catch (e) {
      console.error(`[CoverSweep] failed copying cover for book ${b.id}`, e);
    }
  }

  const result = { scanned: rows.length, copied };
  console.log('[CoverSweep]', JSON.stringify(result));
  return result;
}

export interface CleanupResult {
  cleaned: number;
}

/**
 * Cron sweep: deletes the R2 object and clears cover_r2_key for books that are no longer listed
 * (no active or reserved listing), bounded batch per run.
 */
export async function runCoverCleanup(env: Env, batchSize = COVER_CLEANUP_BATCH_SIZE): Promise<CleanupResult> {
  const db = createDb(env.DB);

  // Books with cover_r2_key but with no active or reserved listing
  const rows = await db
    .select({
      id: books.id,
      coverR2Key: books.coverR2Key,
    })
    .from(books)
    .where(
      and(
        isNotNull(books.coverR2Key),
        sql`NOT EXISTS (SELECT 1 FROM listings l WHERE l.book_id = ${books.id} AND l.status IN ('active', 'reserved'))`,
      ),
    )
    .limit(batchSize);

  if (!rows.length) return { cleaned: 0 };

  const cleanedIds: string[] = [];
  for (const row of rows) {
    if (row.coverR2Key && row.coverR2Key.startsWith('covers/')) {
      try {
        await env.R2.delete(row.coverR2Key);
      } catch (e) {
        console.error(`[CoverCleanup] failed to delete ${row.coverR2Key}`, e);
      }
    }
    cleanedIds.push(row.id);
  }

  if (cleanedIds.length) {
    await db.update(books).set({ coverR2Key: null }).where(inList(books.id, cleanedIds));
  }

  const result = { cleaned: cleanedIds.length };
  console.log('[CoverCleanup]', JSON.stringify(result));
  return result;
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
