import { and, eq, lt, notExists, type SQL } from 'drizzle-orm';
import type { Env } from '../../env';
import { books, createDb, listings, subscriptions } from '../../db';
import { inList } from '../../lib/sql';

/**
 * A book nothing uses is still kept this long after it was created: the sell
 * flow creates the book first and lists it a moment later (and retries the
 * listing on the same book), so a fresh book with no listing is not unused.
 */
export const UNUSED_BOOK_GRACE_MS = 60 * 60 * 1000;

/**
 * Delete books nothing uses: no listing in any status (a sold or removed
 * listing is still the seller's history and what its orders point at) and no
 * request, older than the grace period. `bookIds` limits it to those books;
 * omitted, every book is considered. Their R2 covers go too.
 */
export async function deleteUnusedBooks(env: Env, bookIds?: readonly string[], now = Date.now()): Promise<number> {
  if (bookIds && !bookIds.length) return 0;
  const db = createDb(env.DB);
  const conds: SQL[] = [
    lt(books.createdAt, new Date(now - UNUSED_BOOK_GRACE_MS).toISOString()),
    notExists(db.select({ id: listings.id }).from(listings).where(eq(listings.bookId, books.id))),
    notExists(db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.bookId, books.id))),
  ];
  if (bookIds) conds.push(inList(books.id, bookIds));
  const deleted = await db
    .delete(books)
    .where(and(...conds))
    .returning({ coverR2Key: books.coverR2Key });
  for (const { coverR2Key } of deleted) {
    if (coverR2Key?.startsWith('covers/')) {
      await env.R2.delete(coverR2Key).catch((e: unknown) => console.error('[catalog] failed to delete cover', coverR2Key, e));
    }
  }
  return deleted.length;
}
