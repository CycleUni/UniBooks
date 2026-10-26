/**
 * /api/v1/subscriptions/ ("notify me when someone lists this book").
 */
import { Hono } from 'hono';
import { inList } from '../lib/sql';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppEnv, Env } from '../env';
import { createDb, books, subscriptions, type Book, type Subscription } from '../db';
import { apiError, readJson } from '../lib/http';
import { requireRegion } from '../lib/region';
import { authMiddleware } from '../middleware/auth';
import { cleanAndValidateIsbn, validateBookIsbn } from '../services/catalog/isbn';
import { checkRate } from '../middleware/rateLimit';
import { cleanCoverUrl, cleanPublisher } from '../services/catalog/common';
import { coverUrlFor } from '../services/catalog/covers';
import { getGoogleBooksByIsbn } from '../services/catalog/lookups';
import { UUID_RE } from '../lib/uuid';
import { nowIso } from '../lib/time';
import type { SubscriptionDto } from '../api-types';

export const subscriptionRoutes = new Hono<AppEnv>();

subscriptionRoutes.use('*', authMiddleware());

/** Subscriptions with new_listings_count = active listings created after subscribing. */
async function serialize(env: Env, subs: Subscription[]): Promise<SubscriptionDto[]> {
  if (!subs.length) return [];
  const db = createDb(env.DB);
  const bookIds = [...new Set(subs.map((s) => s.bookId))];
  const bookRows = await db.select().from(books).where(inList(books.id, bookIds));
  const bookMap = new Map(bookRows.map((b) => [b.id, b]));
  const { results: counts } = await env.DB.prepare(
    `SELECT s.id AS id, count(DISTINCT l.id) AS n
       FROM subscriptions s
       JOIN listings l ON l.book_id = s.book_id AND l.status = 'active' AND l.created_at > s.created_at
      WHERE s.id IN (SELECT value FROM json_each(?))
      GROUP BY s.id`,
  )
    .bind(JSON.stringify(subs.map((s) => s.id)))
    .all<{ id: string; n: number }>();
  const countMap = new Map(counts.map((r) => [r.id, Number(r.n)]));
  return subs.map((s) => {
    const book = bookMap.get(s.bookId);
    return {
      id: s.id,
      book: s.bookId,
      bookTitle: book?.title ?? '',
      isbn: book?.isbn13 ?? '',
      bookCoverUrl: book ? coverUrlFor(env, undefined, book) : '',
      newListingsCount: countMap.get(s.id) ?? 0,
      created_at: s.createdAt,
    };
  });
}

subscriptionRoutes.get('/', async (c) => {
  const region = await requireRegion(c);
  const rows = await createDb(c.env.DB)
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, c.get('userId')!), eq(subscriptions.regionCode, region.code)))
    .orderBy(desc(subscriptions.createdAt));
  return c.json(await serialize(c.env, rows));
});

subscriptionRoutes.delete('/', async (c) => {
  const region = await requireRegion(c);
  await createDb(c.env.DB)
    .delete(subscriptions)
    .where(and(eq(subscriptions.userId, c.get('userId')!), eq(subscriptions.regionCode, region.code)));
  return c.body(null, 204);
});

/** Waitlist entries per user; beyond this a subscribe is refused. */
const MAX_SUBSCRIPTIONS_PER_USER = 90;

subscriptionRoutes.post('/', async (c) => {
  // An unknown ISBN costs an external catalogue lookup; bound it.
  await checkRate(c, 'subscribe', '30/hour');
  const body = await readJson(c.req);
  const raw = body.book_id;
  if (raw === undefined || raw === null || raw === '') apiError(400, 'common.errValidation');
  const region = await requireRegion(c);
  const userId = c.get('userId')!;
  const db = createDb(c.env.DB);

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  if (n >= MAX_SUBSCRIPTIONS_PER_USER) apiError(400, 'common.errValidation');

  let book: Book | undefined;
  // Checksum-valid ISBNs only: a typo should not reach Google Books.
  const isbn = cleanAndValidateIsbn(raw) ? validateBookIsbn(raw) : null;
  if (isbn) {
    [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.regionCode, region.code), eq(books.isbn13, isbn)))
      .limit(1);
    if (!book) {
      // Not in the catalogue yet: create it from Google Books.
      const gb = await getGoogleBooksByIsbn(c.env, isbn).catch(() => null);
      if (!gb) apiError(404, 'not_found');
      const row: Book = {
        id: crypto.randomUUID(),
        regionCode: region.code,
        isbn13: isbn,
        title: (gb.title || '').slice(0, 255),
        authors: (gb.authors || '').slice(0, 512),
        publisher: String(cleanPublisher(gb.publisher ?? '')).slice(0, 255),
        publishedDate: (gb.published_date ?? '').slice(0, 50),
        coverUrl: (cleanCoverUrl(gb.cover_url) ?? '').slice(0, 1024),
        coverR2Key: null,
        coverCheckedAt: null,
        source: 'google_api',
        createdAt: nowIso(),
        reviewedAt: null,
        reviewedById: null,
      };
      // A concurrent create of the same ISBN wins; read back whichever row stands.
      await db.insert(books).values(row).onConflictDoNothing();
      [book] = await db
        .select()
        .from(books)
        .where(and(eq(books.regionCode, region.code), eq(books.isbn13, isbn)))
        .limit(1);
    }
  } else {
    const id = typeof raw === 'string' ? raw : '';
    if (!UUID_RE.test(id)) apiError(404, 'not_found');
    [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.regionCode, region.code), eq(books.id, id.toLowerCase())))
      .limit(1);
  }
  if (!book) apiError(404, 'not_found');

  const sub: Subscription = {
    id: crypto.randomUUID(),
    regionCode: region.code,
    userId,
    bookId: book.id,
    schoolId: null,
    notifiedAt: null,
    createdAt: nowIso(),
  };
  const inserted = await db.insert(subscriptions).values(sub).onConflictDoNothing().returning({ id: subscriptions.id });
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.bookId, book.id)))
    .limit(1);
  const [out] = await serialize(c.env, [row]);
  return c.json(out, inserted.length ? 201 : 200);
});

subscriptionRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.body(null, 404);
  const region = await requireRegion(c);
  const deleted = await createDb(c.env.DB)
    .delete(subscriptions)
    .where(
      and(eq(subscriptions.id, id.toLowerCase()), eq(subscriptions.userId, c.get('userId')!), eq(subscriptions.regionCode, region.code)),
    )
    .returning({ id: subscriptions.id });
  return c.body(null, deleted.length ? 204 : 404);
});
