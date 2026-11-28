/**
 * /api/v1/books/
 */
import { Hono } from 'hono';
import { and, desc, eq, max, min, sql } from 'drizzle-orm';
import type { AppEnv, Env } from '../env';
import { notExpired } from '../lib/requestExpiry';
import { createDb, books, listings, subscriptions, type Book } from '../db';
import { apiError, pagination, readJson } from '../lib/http';
import { assertMayTrade, requireRegion } from '../lib/region';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { checkPlatformRate, checkRate } from '../middleware/rateLimit';
import { cleanAndValidateIsbn } from '../services/catalog/isbn';
import { cleanPublisher, describeSource } from '../services/catalog/common';
import {
  GOOGLE_VOLUME_ID_RE,
  ISBN_FALLBACK_ORDER,
  ISBN_LOOKUPS,
  SOURCE_BY_ENGINE,
  engineOrder,
  getGoogleBooksByIsbn,
  lookupInOrder,
  regionSearchEngines,
  type LookupMeta,
} from '../services/catalog/lookups';
import { resolveLanguage, schoolFilterId } from '../services/listings/places';
import { serializeBook, serializeListings } from '../services/listings/serialize';
import { findOrCreateBook } from '../services/catalog/books';
import { drivesForBook } from '../services/drives/claims';
import { UUID_RE } from '../lib/uuid';

export const bookRoutes = new Hono<AppEnv>();

const EMPTY_PAGE = { count: 0, next: null, previous: null, results: [] };

// ------------------------------------------------------------------ detail --

bookRoutes.get('/', optionalAuthMiddleware(), async (c) => {
  const isbn = c.req.query('isbn');
  const bookId = c.req.query('id');
  if (!isbn && !bookId) apiError(400, 'common.errValidation');

  const validIsbn = isbn ? cleanAndValidateIsbn(isbn) : null;
  const region = await requireRegion(c);
  const lang = resolveLanguage(c, region);
  const allowed = regionSearchEngines(region);
  const requested = c.req.query('engine');
  const engine = requested && (allowed as string[]).includes(requested) ? requested : null;
  const db = createDb(c.env.DB);

  let book: Book | undefined;
  if (validIsbn) {
    [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.regionCode, region.code), eq(books.isbn13, validIsbn)))
      .limit(1);
  }
  if (!book) {
    // Not in the catalogue yet: serve the external record. A named engine is
    // asked first and alone; with nothing there, the region's other engines.
    if (validIsbn) {
      // Unknown ISBNs fan out to external catalogues; bound that per client.
      // A book already in the catalogue is one D1 read and is not counted.
      await checkPlatformRate(c, 'book_lookup', '120/min');
      // A search-result link names its Google volume (&gid=): many volumes
      // Google's search returns answer no ISBN query, so without it a
      // shared link found nothing the search page had shown.
      const gid = c.req.query('gid');
      const lookups =
        gid && GOOGLE_VOLUME_ID_RE.test(gid)
          ? { ...ISBN_LOOKUPS, googlebooks: (env: Env, q: string, meta?: LookupMeta) => getGoogleBooksByIsbn(env, q, meta, gid) }
          : ISBN_LOOKUPS;
      let found = await lookupInOrder(c.env, validIsbn, engineOrder(engine, allowed, ISBN_FALLBACK_ORDER), lookups, allowed);
      if (!found.result && engine) {
        const tried = new Set(found.meta.attempts.map((a) => a.engine));
        const rest = engineOrder(null, allowed, ISBN_FALLBACK_ORDER).filter((e) => !tried.has(e));
        if (rest.length) found = await lookupInOrder(c.env, validIsbn, rest, lookups, allowed);
      }
      if (found.result && found.engine) {
        const rec = found.result;
        return c.json({
          id: '',
          isbn13: validIsbn,
          title: rec.title,
          authors: rec.authors,
          publisher: cleanPublisher(rec.publisher ?? ''),
          published_date: rec.published_date ?? '',
          cover_url: rec.cover_url ?? '',
          source: SOURCE_BY_ENGINE[found.engine],
          debug_source: describeSource(found.engine, found.meta.cache_hit ?? false),
          listings: EMPTY_PAGE,
          price_stats: { count: 0, min: null, max: null },
          waiting_count: 0,
          is_subscribed: false,
          subscription_id: null,
        });
      }
    }
    if (!bookId || !UUID_RE.test(bookId)) apiError(404, 'not_found');
    [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.regionCode, region.code), eq(books.id, bookId.toLowerCase())))
      .limit(1);
    if (!book) apiError(404, 'not_found');
  }

  const activeWhere = and(eq(listings.bookId, book.id), eq(listings.regionCode, region.code), eq(listings.status, 'active'));
  const [[agg], [{ waiting }], drives] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)`, lo: min(listings.price), hi: max(listings.price) })
      .from(listings)
      .where(activeWhere),
    db
      .select({ waiting: sql<number>`count(*)` })
      .from(subscriptions)
      .where(eq(subscriptions.bookId, book.id)),
    // Student organizations giving this book away: pinned above the listings.
    drivesForBook(c.env, book.id, region.code, lang, c.get('userId') ?? undefined, new Date().toISOString()),
  ]);
  const count = Number(agg?.n ?? 0);
  const p = pagination(c.req.url);
  const rows = count
    ? await db.select().from(listings).where(activeWhere).orderBy(desc(listings.createdAt)).limit(p.limit).offset(p.offset)
    : [];
  // Shared by every viewer of the book page: seller-only fields stay out.
  const results = await serializeListings(c.env, rows, { stripPrivateNote: true, lang }, new Map([[book.id, book]]));

  const origin = new URL(c.req.url).origin;
  const out: Record<string, unknown> = {
    ...serializeBook(book, c.env, origin),
    listings: p.wrap(results, count),
    price_stats: { count, min: agg?.lo ?? null, max: agg?.hi ?? null },
    waiting_count: Number(waiting),
    drives,
    is_subscribed: false,
    subscription_id: null,
  };

  const userId = c.get('userId');
  if (userId) {
    const [sub] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.regionCode, region.code),
          eq(subscriptions.userId, userId),
          eq(subscriptions.bookId, book.id),
          notExpired(subscriptions.expiresAt),
        ),
      )
      .limit(1);
    if (sub) {
      out.is_subscribed = true;
      out.subscription_id = sub.id;
    }
  }

  const school = c.req.query('school');
  if (school) {
    const schoolId = await schoolFilterId(c.env, region, school);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(listings)
      .where(and(activeWhere, schoolId === null ? undefined : eq(listings.schoolId, schoolId)));
    out.local_listings_count = Number(n);
  } else {
    out.local_listings_count = null;
  }
  return c.json(out);
});

// ------------------------------------------------------------------ manual --

bookRoutes.post('/manual', authMiddleware(), async (c) => {
  const region = await requireRegion(c);
  await assertMayTrade(c, region.code);
  await checkRate(c, 'book_create', '20/hour');
  const body = await readJson(c.req);
  const origin = new URL(c.req.url).origin;
  const { book, created } = await findOrCreateBook(c.env, region.code, body, { isAdmin: c.get('user')!.isAdmin, origin });
  return c.json(serializeBook(book, c.env, origin), created ? 201 : 200);
});
