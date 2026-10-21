import { Hono } from 'hono';
import { inList } from '../../lib/sql';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, count, desc, eq, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { books, createDb, listings, regions, subscriptions, type Book, type Database } from '../../db';
import { apiError, pagination, readJson } from '../../lib/http';
import { auditInsert } from '../../services/admin/audit';
import { notFound, regionParam, scopeOf, scopeWhere, uuidId } from '../../services/admin/scope';
import { cleanCoverUrl, cleanPublisher } from '../../services/catalog/common';
import { validateBookIsbn } from '../../services/catalog/isbn';
import {
  engineOrder,
  ISBN_FALLBACK_ORDER,
  ISBN_LOOKUPS,
  lookupInOrder,
  regionSearchEngines,
  SOURCE_BY_ENGINE,
} from '../../services/catalog/lookups';
import { serializeBook } from '../../services/listings/serialize';
import { dropCoverCopy } from '../../services/catalog/covers';
import { bookSearch } from './listings';
import { isUniqueViolation } from '../../lib/db';

/**
 * Correcting a book's catalogue record,
 * merging misfiled books, and the manual-book review queue.
 */
export const bookRoutes = new Hono<AppEnv>();

const BOOK_SOURCES = ['listed', 'preseed', 'manual', 'google_api', 'openlibrary_api', 'isbnnet_api'] as const;
const TEXT_FIELDS: Record<string, number> = { title: 255, authors: 512, publisher: 255, published_date: 50 };
const MAX_BULK_REVIEW = 100;

function invalidField(): never {
  apiError(400, 'admin.errInvalidField');
}
function invalidIsbn(): never {
  apiError(400, 'listing.errInvalidIsbn');
}

function isbnTaken(other: Pick<Book, 'id' | 'title'> | null | undefined): never {
  throw new HTTPException(409, {
    res: Response.json(
      { error: { code: 'admin.errBookIsbnTaken', existing_book: other ? { id: other.id, title: other.title } : null } },
      { status: 409 },
    ),
  });
}

const activeListingsSql = sql<number>`(SELECT count(*) FROM ${listings} WHERE ${listings.bookId} = ${books.id} AND ${listings.status} = 'active')`;
const requestCountSql = sql<number>`(SELECT count(*) FROM ${subscriptions} WHERE ${subscriptions.bookId} = ${books.id})`;

function bookWithCounts(db: Database) {
  return db.select({ b: books, activeListings: activeListingsSql, requestCount: requestCountSql }).from(books);
}

function adminBookJson(row: { b: Book; activeListings: number; requestCount: number }, env?: AppEnv['Bindings'], origin?: string) {
  return {
    ...serializeBook(row.b, env, origin),
    reviewed_at: row.b.reviewedAt,
    active_listings: row.activeListings,
    request_count: row.requestCount,
    pending_review: row.b.source === 'manual' && row.b.reviewedAt === null,
  };
}

const REVIEW_FILTERS: Record<string, SQL> = {
  pending: and(eq(books.source, 'manual'), isNull(books.reviewedAt))!,
  confirmed: and(eq(books.source, 'manual'), isNotNull(books.reviewedAt))!,
};

bookRoutes.get('/books', async (c) => {
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const conds: (SQL | undefined)[] = [scopeWhere(books.regionCode, await scopeOf(c))];
  const q = (c.req.query('q') ?? '').trim();
  if (q) conds.push(bookSearch(q));
  const region = regionParam(c);
  if (region) conds.push(eq(books.regionCode, region));
  const review = REVIEW_FILTERS[c.req.query('review') ?? ''];
  if (review) conds.push(review);
  const where = and(...conds);
  const [{ n }] = await db.select({ n: count() }).from(books).where(where);
  const rows = await bookWithCounts(db).where(where).orderBy(desc(books.createdAt), desc(books.id)).limit(page.limit).offset(page.offset);
  const origin = new URL(c.req.url).origin;
  return c.json(
    page.wrap(
      rows.map((r) => adminBookJson(r, c.env, origin)),
      n,
    ),
  );
});

// ---------------------------------------------------------------------------
// Bulk review (before /books/:id/)
// ---------------------------------------------------------------------------

function bulkIds(data: Record<string, unknown>): string[] {
  const ids = data.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BULK_REVIEW) invalidField();
  if (!ids.every((i) => typeof i === 'string' && /^[0-9a-f-]{36}$/i.test(i))) invalidField();
  return [...new Set((ids as string[]).map((i) => i.toLowerCase()))];
}

bookRoutes.post('/books/confirm-manual', async (c) => {
  const ids = bulkIds(await readJson(c.req));
  const db = createDb(c.env.DB);
  const me = c.get('user')!;
  const now = new Date().toISOString();
  // Conditional update: a book confirmed concurrently is not confirmed twice.
  const changed = await db
    .update(books)
    .set({ reviewedAt: now, reviewedById: me.id })
    .where(and(inList(books.id, ids), eq(books.source, 'manual'), isNull(books.reviewedAt), scopeWhere(books.regionCode, await scopeOf(c))))
    .returning({ id: books.id, isbn13: books.isbn13, title: books.title });
  if (changed.length) {
    const audits = changed.map((b) =>
      auditInsert(
        db,
        {
          actorId: me.id,
          kind: 'admin.book_manual_confirmed',
          meta: { book_id: b.id, isbn13: b.isbn13, title: b.title },
          targetType: 'book',
          targetId: b.id,
        },
        c,
      ),
    );
    await db.batch(audits as [(typeof audits)[0], ...typeof audits]);
  }
  return c.json({ confirmed: changed.map((b) => b.id).sort() });
});

bookRoutes.post('/books/reopen-review', async (c) => {
  const ids = bulkIds(await readJson(c.req));
  const db = createDb(c.env.DB);
  const me = c.get('user')!;
  const changed = await db
    .update(books)
    .set({ reviewedAt: null, reviewedById: null })
    .where(
      and(inList(books.id, ids), eq(books.source, 'manual'), isNotNull(books.reviewedAt), scopeWhere(books.regionCode, await scopeOf(c))),
    )
    .returning({ id: books.id, isbn13: books.isbn13, title: books.title });
  if (changed.length) {
    const audits = changed.map((b) =>
      auditInsert(
        db,
        {
          actorId: me.id,
          kind: 'admin.book_review_reopened',
          meta: { book_id: b.id, isbn13: b.isbn13, title: b.title },
          targetType: 'book',
          targetId: b.id,
        },
        c,
      ),
    );
    await db.batch(audits as [(typeof audits)[0], ...typeof audits]);
  }
  return c.json({ reopened: changed.map((b) => b.id).sort() });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

async function loadBook(c: Context<AppEnv>, db: Database, id = uuidId(c.req.param('id'))) {
  const [row] = await bookWithCounts(db)
    .where(and(eq(books.id, id), scopeWhere(books.regionCode, await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

async function otherBookWith(db: Database, book: Book, isbn: string): Promise<Book | undefined> {
  const [other] = await db
    .select()
    .from(books)
    .where(and(eq(books.regionCode, book.regionCode), eq(books.isbn13, isbn), ne(books.id, book.id)))
    .limit(1);
  return other;
}

bookRoutes.get('/books/:id', async (c) => c.json(adminBookJson(await loadBook(c, createDb(c.env.DB)), c.env, new URL(c.req.url).origin)));

bookRoutes.get('/books/:id/lookup', async (c) => {
  const db = createDb(c.env.DB);
  const { b: book } = await loadBook(c, db);
  const isbn = validateBookIsbn(c.req.query('isbn'));
  if (!isbn) invalidIsbn();
  const [region] = await db.select().from(regions).where(eq(regions.code, book.regionCode)).limit(1);
  const allowed = regionSearchEngines(region ?? null);
  const { result, engine } = await lookupInOrder(c.env, isbn, engineOrder(null, allowed, ISBN_FALLBACK_ORDER), ISBN_LOOKUPS, allowed);
  if (!result || !engine) apiError(404, 'admin.errBookLookupNotFound');
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const other = await otherBookWith(db, book, isbn);
  return c.json({
    isbn13: isbn,
    title: text(result.title),
    authors: text(result.authors),
    publisher: cleanPublisher(text(result.publisher)),
    published_date: text(result.published_date),
    cover_url: text(result.cover_url),
    source: SOURCE_BY_ENGINE[engine],
    existing_book: other ? { id: other.id, title: other.title } : null,
  });
});

type BookUpdates = Partial<Pick<Book, 'title' | 'authors' | 'publisher' | 'publishedDate' | 'coverUrl' | 'source' | 'isbn13'>>;
const COLUMN: Record<string, keyof BookUpdates> = {
  title: 'title',
  authors: 'authors',
  publisher: 'publisher',
  published_date: 'publishedDate',
};

function parseUpdates(data: Record<string, unknown>): BookUpdates {
  const updates: BookUpdates = {};
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (field in data) {
      const v = data[field];
      if (typeof v !== 'string') invalidField();
      (updates as Record<string, unknown>)[COLUMN[field]] = v.trim().slice(0, max);
    }
  }
  if (updates.title !== undefined && !updates.title) invalidField();
  if (updates.publisher !== undefined) updates.publisher = String(cleanPublisher(updates.publisher));
  if ('cover_url' in data) {
    const cover = cleanCoverUrl(data.cover_url);
    if (cover === null) invalidField();
    updates.coverUrl = cover as string;
  }
  if ('source' in data) {
    const s = data.source;
    if (typeof s !== 'string' || !(BOOK_SOURCES as readonly string[]).includes(s)) invalidField();
    updates.source = s as Book['source'];
  }
  if ('isbn13' in data) {
    const raw = data.isbn13;
    if (raw === '' || raw === null) updates.isbn13 = null;
    else {
      const isbn = validateBookIsbn(raw);
      if (!isbn) invalidIsbn();
      updates.isbn13 = isbn;
    }
  }
  return updates;
}

bookRoutes.patch('/books/:id', async (c) => {
  const db = createDb(c.env.DB);
  const { b: book } = await loadBook(c, db);
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalidField();
  const data = raw as Record<string, unknown>;
  const updates = parseUpdates(data);
  // A book awaiting review leaves 'manual' only through confirm-manual, never by relabelling its source.
  if (book.source === 'manual' && book.reviewedAt === null && updates.source !== undefined && updates.source !== 'manual') invalidField();
  const isbn = updates.isbn13;
  const merge = data.merge === true;
  const me = c.get('user')!;

  const target = isbn ? await otherBookWith(db, book, isbn) : undefined;
  if (target && !merge) isbnTaken(target);

  if (target) {
    // Fold `book` into `target`: its listings and requests move over (a
    // requester already waiting on target keeps that one), then it goes.
    const listingIds = (await db.select({ id: listings.id }).from(listings).where(eq(listings.bookId, book.id))).map((l) => l.id);
    const already = new Set(
      (await db.select({ userId: subscriptions.userId }).from(subscriptions).where(eq(subscriptions.bookId, target.id))).map(
        (s) => s.userId,
      ),
    );
    const srcSubs = await db.select().from(subscriptions).where(eq(subscriptions.bookId, book.id));
    const dropped = srcSubs.filter((s) => already.has(s.userId));
    const moved = srcSubs.filter((s) => !already.has(s.userId));
    const now = new Date().toISOString();
    const statements = [
      db.update(listings).set({ bookId: target.id, updatedAt: now }).where(eq(listings.bookId, book.id)),
      ...(dropped.length
        ? [
            db.delete(subscriptions).where(
              inList(
                subscriptions.id,
                dropped.map((s) => s.id),
              ),
            ),
          ]
        : []),
      db.update(subscriptions).set({ bookId: target.id }).where(eq(subscriptions.bookId, book.id)),
      db.delete(books).where(eq(books.id, book.id)),
      auditInsert(
        db,
        {
          actorId: me.id,
          kind: 'admin.book_merged',
          meta: {
            book_id: book.id,
            book: {
              id: book.id,
              isbn13: book.isbn13,
              title: book.title,
              authors: book.authors,
              publisher: book.publisher,
              published_date: book.publishedDate,
              cover_url: book.coverUrl,
              source: book.source,
              created_at: book.createdAt,
            },
            into_book_id: target.id,
            into_isbn13: target.isbn13,
            listing_ids: listingIds,
            moved_subscription_ids: moved.map((s) => s.id),
            dropped_subscriptions: dropped.map((s) => ({
              id: s.id,
              user_id: s.userId,
              school_id: s.schoolId,
              created_at: s.createdAt,
              notified_at: s.notifiedAt,
            })),
          },
          targetType: 'book',
          targetId: book.id,
        },
        c,
      ),
    ];
    await db.batch(statements as [(typeof statements)[0], ...typeof statements]);
    if (book.coverR2Key && book.coverR2Key.startsWith('covers/')) {
      await c.env.R2.delete(book.coverR2Key).catch((e: unknown) => console.error(`[admin/books] failed to delete ${book.coverR2Key}`, e));
    }
    const [fresh] = await db.select().from(books).where(eq(books.id, target.id)).limit(1);
    const origin = new URL(c.req.url).origin;
    return c.json({ merged_into: target.id, book: serializeBook(fresh ?? target, c.env, origin) });
  }

  const set: Partial<Book> = { ...updates };
  if (Object.keys(updates).length) {
    if ('isbn13' in updates && updates.isbn13 !== book.isbn13 && book.reviewedAt) {
      // The review vouched for the old ISBN, not the new one.
      set.reviewedAt = null;
      set.reviewedById = null;
    }
    if ('coverUrl' in updates && updates.coverUrl !== book.coverUrl) {
      await dropCoverCopy(c.env, book);
      set.coverR2Key = null;
      set.coverCheckedAt = null;
    }
    const camelToSnake: Record<string, string> = {
      title: 'title',
      authors: 'authors',
      publisher: 'publisher',
      publishedDate: 'published_date',
      coverUrl: 'cover_url',
      source: 'source',
      isbn13: 'isbn13',
      reviewedAt: 'reviewed_at',
      reviewedById: 'reviewed_by_id',
    };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) {
      before[camelToSnake[k]] = (book as Record<string, unknown>)[k];
      after[camelToSnake[k]] = v;
    }
    try {
      await db.batch([
        db.update(books).set(set).where(eq(books.id, book.id)),
        auditInsert(
          db,
          { actorId: me.id, kind: 'admin.book_updated', meta: { book_id: book.id, before, after }, targetType: 'book', targetId: book.id },
          c,
        ),
      ]);
    } catch (e) {
      // (region, isbn13) is unique: another book took this ISBN meanwhile.
      if (isbn && isUniqueViolation(e)) isbnTaken(await otherBookWith(db, book, isbn));
      throw e;
    }
  }
  const [fresh] = await db.select().from(books).where(eq(books.id, book.id)).limit(1);
  const origin = new URL(c.req.url).origin;
  return c.json({ merged_into: null, book: serializeBook(fresh, c.env, origin) });
});

bookRoutes.post('/books/:id/confirm-manual', async (c) => {
  const db = createDb(c.env.DB);
  const { b: book } = await loadBook(c, db);
  if (book.source !== 'manual') apiError(400, 'admin.errBookNotManual');
  const me = c.get('user')!;
  const [done] = await db
    .update(books)
    .set({ reviewedAt: new Date().toISOString(), reviewedById: me.id })
    .where(and(eq(books.id, book.id), isNull(books.reviewedAt)))
    .returning({ id: books.id });
  if (done) {
    await auditInsert(
      db,
      {
        actorId: me.id,
        kind: 'admin.book_manual_confirmed',
        meta: { book_id: book.id, isbn13: book.isbn13, title: book.title },
        targetType: 'book',
        targetId: book.id,
      },
      c,
    );
  }
  return c.json(adminBookJson(await loadBook(c, db, book.id), c.env, new URL(c.req.url).origin));
});
