import { and, count, desc, eq, exists, isNotNull } from 'drizzle-orm';
import type { Env } from '../../env';
import { books, createDb, regionVerifications, subscriptions } from '../../db';
import { cached } from '../../lib/cache';
import { NO_SCHOOL_ID } from './places';

export interface WaitlistEntry {
  title: unknown;
  count: number;
  book_id: unknown;
  cover_url: unknown;
  isbn: unknown;
  authors: unknown;
}

/**
 * The most-wanted books of a region: those with the most subscribers, counting
 * only subscribers verified at `schoolId` when one is given. Counts may lag
 * five minutes.
 */
export async function mostWanted(env: Env, regionCode: string, schoolId: number | null): Promise<WaitlistEntry[]> {
  // A ?school= that names no school here: an empty list, never "every school".
  if (schoolId === NO_SCHOOL_ID) return [];
  return cached(env, 'ref', `waitlist:${regionCode}:${schoolId ?? ''}`, 300, async () => {
    const bySchool =
      schoolId === null
        ? undefined
        : exists(
            createDb(env.DB)
              .select({ id: regionVerifications.id })
              .from(regionVerifications)
              .where(
                and(
                  eq(regionVerifications.userId, subscriptions.userId),
                  eq(regionVerifications.regionCode, subscriptions.regionCode),
                  eq(regionVerifications.schoolId, schoolId),
                  eq(regionVerifications.isActive, 1),
                  isNotNull(regionVerifications.verifiedAt),
                ),
              ),
          );
    const n = count(subscriptions.userId);
    const rows = await createDb(env.DB)
      .select({
        bookId: subscriptions.bookId,
        title: books.title,
        coverUrl: books.coverUrl,
        isbn13: books.isbn13,
        authors: books.authors,
        n,
      })
      .from(subscriptions)
      .innerJoin(books, eq(books.id, subscriptions.bookId))
      .where(and(eq(subscriptions.regionCode, regionCode), bySchool))
      .groupBy(subscriptions.bookId, books.title, books.coverUrl, books.isbn13, books.authors)
      .orderBy(desc(n))
      .limit(7);
    return rows.map((r) => ({
      title: r.title,
      count: Number(r.n),
      book_id: r.bookId,
      cover_url: r.coverUrl,
      isbn: r.isbn13,
      authors: r.authors,
    }));
  });
}
