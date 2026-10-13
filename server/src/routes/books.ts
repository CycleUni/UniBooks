/**
 * /api/v1/books/
 */
import { Hono } from 'hono';
import { and, desc, eq, max, min, sql } from 'drizzle-orm';
import type { AppEnv, Env } from '../env';
import { createDb, books, listings, subscriptions, type Book, type InsertBook } from '../db';
import { apiError, fieldErrors, readJson } from '../lib/http';
import { assertVerifiedIn, requireRegion } from '../lib/region';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { checkRate } from '../middleware/rateLimit';
import { cleanAndValidateIsbn, validateBookIsbn } from '../services/catalog/isbn';
import { cleanCoverUrl, cleanPublisher, describeSource } from '../services/catalog/common';
import {
  ISBN_FALLBACK_ORDER,
  ISBN_LOOKUPS,
  SOURCE_BY_ENGINE,
  engineOrder,
  lookupInOrder,
  regionSearchEngines,
  type BookRecord,
} from '../services/catalog/lookups';
import { resolveLanguage, schoolFilterId } from '../services/listings/places';
import { serializeBook, serializeListings } from '../services/listings/serialize';
import { pageFor } from '../services/listings/lifecycle';
import { UUID_RE } from '../lib/uuid';
import { nowIso } from '../lib/time';

export const bookRoutes = new Hono<AppEnv>();

const EMPTY_PAGE = { count: 0, next: null, previous: null, results: [] };

// ------------------------------------------------------------------ detail --

bookRoutes.get('/', optionalAuthMiddleware(), async (c) => {
  // Unknown ISBNs fan out to external catalogues; bound that per client.
  await checkRate(c, 'book_lookup', '120/min');
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
      let found = await lookupInOrder(c.env, validIsbn, engineOrder(engine, allowed, ISBN_FALLBACK_ORDER), ISBN_LOOKUPS, allowed);
      if (!found.result && engine) {
        const tried = new Set(found.meta.attempts.map((a) => a.engine));
        const rest = engineOrder(null, allowed, ISBN_FALLBACK_ORDER).filter((e) => !tried.has(e));
        if (rest.length) found = await lookupInOrder(c.env, validIsbn, rest, ISBN_LOOKUPS, allowed);
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
  const [[agg], [{ waiting }]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)`, lo: min(listings.price), hi: max(listings.price) })
      .from(listings)
      .where(activeWhere),
    db
      .select({ waiting: sql<number>`count(*)` })
      .from(subscriptions)
      .where(eq(subscriptions.bookId, book.id)),
  ]);
  const count = Number(agg?.n ?? 0);
  const p = pageFor(c.req.url, count);
  const rows = count
    ? await db.select().from(listings).where(activeWhere).orderBy(desc(listings.createdAt)).limit(p.limit).offset(p.offset)
    : [];
  // Shared by every viewer of the book page: seller-only fields stay out.
  const results = await serializeListings(c.env, rows, { stripPrivateNote: true, lang }, new Map([[book.id, book]]));

  const out: Record<string, unknown> = {
    ...serializeBook(book),
    listings: p.wrap(results, count),
    price_stats: { count, min: agg?.lo ?? null, max: agg?.hi ?? null },
    waiting_count: Number(waiting),
    is_subscribed: false,
    subscription_id: null,
  };

  const userId = c.get('userId');
  if (userId) {
    const [sub] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.regionCode, region.code), eq(subscriptions.userId, userId), eq(subscriptions.bookId, book.id)))
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

const CLAIMABLE_SOURCES: Record<string, keyof typeof ISBN_LOOKUPS> = {
  google_api: 'googlebooks',
  openlibrary_api: 'openlibrary',
  isbnnet_api: 'isbnnet',
};

/**
 * The catalogue's own record behind a claimed source, or null: anything but
 * 'manual' keeps a book out of the admin review queue, so the claim is
 * checked rather than trusted.
 */
async function vettedCatalogueRecord(env: Env, claimed: unknown, isbn13: string | null): Promise<BookRecord | null> {
  const engine = typeof claimed === 'string' ? CLAIMABLE_SOURCES[claimed] : undefined;
  if (!engine || !isbn13) return null;
  try {
    return await ISBN_LOOKUPS[engine](env, isbn13);
  } catch (e) {
    console.warn('[books] could not vet source', claimed, isbn13, e);
    return null;
  }
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

bookRoutes.post('/manual/', authMiddleware(), async (c) => {
  const region = await requireRegion(c);
  await assertVerifiedIn(c, region.code);
  await checkRate(c, 'book_create', '20/hour');
  const body = await readJson(c.req);
  const db = createDb(c.env.DB);

  const coverUrl = 'cover_url' in body ? cleanCoverUrl(body.cover_url) || '' : undefined;

  let isbn13: string | null = null;
  if (body.isbn13 !== undefined && body.isbn13 !== null && body.isbn13 !== '') {
    isbn13 = validateBookIsbn(body.isbn13);
    if (!isbn13) apiError(400, 'listing.errInvalidIsbn');
    const [existing] = await db
      .select()
      .from(books)
      .where(and(eq(books.regionCode, region.code), eq(books.isbn13, isbn13)))
      .limit(1);
    if (existing) {
      // Fill gaps in the shared record; never overwrite what is there.
      const patch: Partial<InsertBook> = {};
      const publisher = str(body.publisher);
      const published = str(body.published_date);
      if (!existing.coverUrl && coverUrl) patch.coverUrl = coverUrl;
      if (!existing.publisher && publisher) patch.publisher = String(cleanPublisher(publisher)).slice(0, 255);
      if (!existing.publishedDate && published) patch.publishedDate = published.slice(0, 50);
      if (Object.keys(patch).length) {
        await db.update(books).set(patch).where(eq(books.id, existing.id));
        Object.assign(existing, patch);
      }
      return c.json(serializeBook(existing), 200);
    }
  }

  let title = str(body.title);
  let authors = str(body.authors);
  let source: InsertBook['source'] = 'manual';
  const record = await vettedCatalogueRecord(c.env, body.source, isbn13);
  if (record) {
    // The catalogue's title and authors, not the seller's.
    source = body.source as InsertBook['source'];
    title = record.title || title;
    authors = record.authors || authors || '';
  }

  // Book field validation.
  const errors: Record<string, string[]> = {};
  const publisher = str(body.publisher) ?? '';
  const publishedDate = str(body.published_date) ?? '';
  if (!title || !title.trim()) errors.title = ['common.errValidation'];
  else if (title.length > 255) errors.title = ['common.errValidation'];
  if ((authors ?? '').length > 512) errors.authors = ['common.errValidation'];
  if (publisher.length > 255) errors.publisher = ['common.errValidation'];
  if (publishedDate.length > 50) errors.published_date = ['common.errValidation'];
  if (Object.keys(errors).length) fieldErrors(errors);

  const row: InsertBook = {
    id: crypto.randomUUID(),
    regionCode: region.code,
    isbn13,
    title: title!.trim(),
    authors: (authors ?? '').trim(),
    publisher: String(cleanPublisher(publisher)),
    publishedDate,
    coverUrl: coverUrl ?? '',
    source,
    createdAt: nowIso(),
    reviewedAt: null,
    reviewedById: null,
  };
  try {
    await db.insert(books).values(row);
  } catch (e) {
    // Lost a race with another create of the same ISBN.
    if (isbn13 && /UNIQUE/i.test(String(e))) fieldErrors({ non_field_errors: ['listing.errIsbnTaken'] });
    throw e;
  }
  return c.json(serializeBook(row as Book), 201);
});
