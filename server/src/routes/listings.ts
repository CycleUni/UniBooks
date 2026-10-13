/**
 * /api/v1/listings/
 */
import { Hono, type Context } from 'hono';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { createDb, books, listings, regionVerifications, schools, type Listing } from '../db';
import { apiError, fieldErrors, readJson } from '../lib/http';
import { assertVerifiedIn, requireRegion } from '../lib/region';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { checkRate } from '../middleware/rateLimit';
import { validateBookIsbn } from '../services/catalog/isbn';
import { nowIso } from '../lib/time';
import { resolveLanguage, schoolFilterId, schoolFilterScope } from '../services/listings/places';
import { serializeListings } from '../services/listings/serialize';
import { validateListingFields, type FieldErrors } from '../services/listings/validate';
import { deleteListing, hasActiveOrders, pageFor } from '../services/listings/lifecycle';
import { permanentKeyPrefix, PhotoError, acceptListingPhotos, listingsHoldingPhoto, tmpKeyPrefix } from '../services/listings/photos';
import { storageKeyFromUrl } from '../lib/media';
import { issueUpload, storeUpload } from '../lib/upload';
import { cancelOpenOrdersForListing } from '../services/orders/cancel';
import { UUID_PATTERN } from '../lib/uuid';
import { parsePhotos } from '../lib/json';
import { UPLOAD_RATE } from '../lib/upload';

export const listingRoutes = new Hono<AppEnv>();

const RATES = { search: '60/min', listing_create: '10/hour', upload: UPLOAD_RATE } as const;

const origin = (c: Context<AppEnv>) => new URL(c.req.url).origin;
const notFound = (c: Context<AppEnv>) => c.body(null, 404);

async function loadListing(c: Context<AppEnv>, id: string): Promise<Listing | undefined> {
  const [row] = await createDb(c.env.DB).select().from(listings).where(eq(listings.id, id)).limit(1);
  return row;
}

// ------------------------------------------------------------- list/create --

listingRoutes.get('/', optionalAuthMiddleware(), async (c) => {
  await checkRate(c, 'search', RATES.search);
  const region = await requireRegion(c);
  const lang = resolveLanguage(c, region);
  const schoolId = await schoolFilterId(c.env, region, c.req.query('school') ?? '');
  const sellerId = c.req.query('seller_id') ?? '';

  const where: SQL[] = [eq(listings.regionCode, region.code), eq(listings.status, 'active')];
  if (schoolId !== null) where.push(eq(listings.schoolId, schoolId));
  if (sellerId) where.push(eq(listings.sellerId, sellerId));
  const db = createDb(c.env.DB);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(listings)
    .where(and(...where));
  const count = Math.min(Number(n), 4000); // the feed is capped at 4000
  const p = pageFor(c.req.url, count);
  const limit = Math.max(0, Math.min(p.limit, count - p.offset));
  const rows = limit
    ? await db
        .select()
        .from(listings)
        .where(and(...where))
        .orderBy(desc(listings.createdAt))
        .limit(limit)
        .offset(p.offset)
    : [];
  // A public body: seller-only fields stay out whoever asks.
  const results = await serializeListings(c.env, rows, { stripPrivateNote: true, lang });
  return c.json(p.wrap(results, count));
});

listingRoutes.post('/', authMiddleware(), async (c) => {
  const region = await requireRegion(c);
  await assertVerifiedIn(c, region.code);
  await checkRate(c, 'listing_create', RATES.listing_create);
  const user = c.get('user')!;
  const body = await readJson(c.req);

  const { values, errors } = await validateListingFields(c.env, body, { regionCode: region.code });
  let photos: string[] = [];
  if (!Object.keys(errors).length && Object.prototype.hasOwnProperty.call(body, 'photos')) {
    try {
      photos = await acceptListingPhotos(c.env, origin(c), body.photos, user.id);
    } catch (e) {
      if (!(e instanceof PhotoError)) throw e;
      errors.photos = [e.code];
    }
  }
  if (Object.keys(errors).length) {
    apiError(400, 'sell.errValidation', { fields: errors });
  }

  // The listing is stamped with the school the seller is verified at here:
  // every school-filtered feed reads the listing's own school.
  const [verification] = (await createDb(c.env.DB)
    .select()
    .from(regionVerifications)
    .where(
      and(eq(regionVerifications.userId, user.id), eq(regionVerifications.regionCode, region.code), eq(regionVerifications.isActive, 1)),
    )
    .limit(1)) as Array<Record<string, unknown>>;
  const schoolId = typeof verification?.schoolId === 'number' ? verification.schoolId : null;

  const now = nowIso();
  const row: Listing = {
    id: crypto.randomUUID(),
    regionCode: region.code,
    currencyCode: region.defaultCurrency,
    bookId: values.bookId!,
    sellerId: user.id,
    schoolId,
    price: values.price!,
    condition: values.condition!,
    privateNote: values.privateNote ?? '',
    description: values.description ?? '',
    photos: JSON.stringify(photos),
    categoryId: values.categoryId ?? null,
    status: 'active',
    adminLocked: 0,
    adminLockReason: '',
    lockedById: null,
    lockedAt: null,
    courseName: values.courseName ?? '',
    professorName: values.professorName ?? '',
    createdAt: now,
    updatedAt: now,
  };
  await createDb(c.env.DB).insert(listings).values(row);
  const lang = resolveLanguage(c, region);
  const [out] = await serializeListings(c.env, [row], { viewerId: user.id, lang }, new Map([[values.book!.id, values.book!]]));
  return c.json(out, 201);
});

// ------------------------------------------------------------ recent books --

listingRoutes.get('/recent_books/', async (c) => {
  const region = await requireRegion(c);
  const limitParam = c.req.query('limit') ?? '200';
  const limit = /^\d+$/.test(limitParam) ? Math.min(Math.max(Number(limitParam), 1), 200) : 200;
  const { schoolId, city } = await schoolFilterScope(c.env, region, c.req.query('school') ?? '');
  const db = c.env.DB;

  // Listing-side place filter as SQL + bind values.
  const placeSql = (schoolIds: number[] | null) =>
    schoolIds === null
      ? { sql: '', args: [] as unknown[] }
      : { sql: ' AND l.school_id IN (SELECT value FROM json_each(?))', args: [JSON.stringify(schoolIds)] };

  const countBooks = async (place: ReturnType<typeof placeSql>) => {
    const row = await db
      .prepare(
        `SELECT count(DISTINCT b.id) AS n FROM books b JOIN listings l ON l.book_id = b.id
          WHERE b.region_code = ? AND l.status = 'active'${place.sql}`,
      )
      .bind(region.code, ...place.args)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  };

  let scope: 'all' | 'school' | 'city' = schoolId === null ? 'all' : 'school';
  let place = placeSql(schoolId === null ? null : [schoolId]);
  let count = await countBooks(place);
  // Nothing at the chosen school: the rest of its city, said so via `scope`.
  if (city !== null && count === 0) {
    const citySchools = (
      (await createDb(c.env.DB).select().from(schools).where(eq(schools.regionCode, region.code))) as Array<Record<string, unknown>>
    )
      .filter((s) => s.cityId === city.id)
      .map((s) => Number(s.id));
    const cityPlace = placeSql(citySchools);
    const cityCount = await countBooks(cityPlace);
    if (cityCount > 0) {
      place = cityPlace;
      count = cityCount;
      scope = 'city';
    }
  }
  const scopeFields = { scope, city: city?.code ?? null };

  const p = pageFor(c.req.url, count);
  const { results: bookRows } = await db
    .prepare(
      `SELECT b.id, b.isbn13, b.title, b.authors, b.cover_url, MAX(l.created_at) AS latest
         FROM books b JOIN listings l ON l.book_id = b.id
        WHERE b.region_code = ? AND l.status = 'active'${place.sql}
        GROUP BY b.id ORDER BY latest DESC, b.id LIMIT ? OFFSET ?`,
    )
    .bind(region.code, ...place.args, p.limit, p.offset)
    .all<{ id: string; isbn13: string | null; title: string; authors: string; cover_url: string }>();
  const page = bookRows.slice(0, limit);
  if (!page.length) return c.json({ ...p.wrap([], count), ...scopeFields });

  const { results: stats } = await db
    .prepare(
      `SELECT l.book_id, l.price, l.condition FROM listings l
        WHERE l.book_id IN (SELECT value FROM json_each(?)) AND l.status = 'active' AND l.region_code = ?${place.sql}`,
    )
    .bind(JSON.stringify(page.map((b) => b.id)), region.code, ...place.args)
    .all<{ book_id: string; price: number; condition: string }>();
  const byBook = new Map<string, { prices: number[]; conditions: Record<string, number> }>();
  for (const s of stats) {
    const e = byBook.get(s.book_id) ?? { prices: [], conditions: {} };
    e.prices.push(s.price);
    e.conditions[s.condition] = (e.conditions[s.condition] ?? 0) + 1;
    byBook.set(s.book_id, e);
  }
  const results = page.map((b) => {
    const st = byBook.get(b.id) ?? { prices: [], conditions: {} };
    const avg = st.prices.length ? st.prices.reduce((a, x) => a + x, 0) / st.prices.length : null;
    return {
      id: b.id,
      isbn: b.isbn13,
      title: b.title,
      authors: b.authors,
      cover_url: b.cover_url,
      avg_price: avg === null ? null : Math.round(avg),
      min_price: st.prices.length ? Math.min(...st.prices) : null,
      max_price: st.prices.length ? Math.max(...st.prices) : null,
      conditions: st.conditions,
    };
  });
  return c.json({ ...p.wrap(results, count), ...scopeFields });
});

// ------------------------------------------------------------------ uploads --

/** Step one (lib/upload.ts): photos wait under the uploader's tmp/ folder until a listing is saved. */
listingRoutes.post('/uploads/', authMiddleware(), async (c) => {
  await checkRate(c, 'upload', RATES.upload);
  const user = c.get('user')!;
  return issueUpload(
    c,
    { action: 'listing_photo', userId: user.id, keyPrefix: tmpKeyPrefix(user.id), base: '/api/v1/listings/' },
    await readJson(c.req),
  );
});

/** Step two: the upload token is the credential. */
listingRoutes.put('/uploads/file/', (c) => storeUpload(c, { action: 'listing_photo', keyPrefix: tmpKeyPrefix }));

/**
 * Delete an upload the caller owns: their own pending tmp upload, or a
 * permanent photo every listing showing which is theirs. Fail closed.
 */
listingRoutes.delete('/uploads/', authMiddleware(), async (c) => {
  await checkRate(c, 'upload', RATES.upload);
  const user = c.get('user')!;
  let url: unknown = c.req.query('url');
  if (!url) url = (await readJson(c.req)).url;
  if (!url || typeof url !== 'string') apiError(400, 'listing.errValidation');
  const res = storageKeyFromUrl(c.env, origin(c), url);
  if ('error' in res) apiError(400, 'listing.errPhotoHostNotAllowed');
  const { key } = res;

  if (key.startsWith(tmpKeyPrefix(user.id))) {
    await c.env.R2.delete(key);
    return c.body(null, 204);
  }
  if (key.startsWith(permanentKeyPrefix(user.id))) {
    const holders = await listingsHoldingPhoto(c.env, url);
    if (holders.length && holders.every((h) => h.sellerId === user.id)) {
      await c.env.R2.delete(key);
      return c.body(null, 204);
    }
  }
  apiError(403, 'listing.errPhotoNotOwned');
});

// ------------------------------------------------------------------ detail --

listingRoutes.get(`/:id{${UUID_PATTERN}}/`, optionalAuthMiddleware(), async (c) => {
  const listing = await loadListing(c, c.req.param('id'));
  if (!listing) return notFound(c);
  const region = await requireRegion(c);
  const userId = c.get('userId');
  // The seller gets their note back; everyone else never sees it.
  const [out] = await serializeListings(c.env, [listing], { viewerId: userId, lang: resolveLanguage(c, region) });
  if (userId && userId === listing.sellerId) out.private_note = listing.privateNote ?? '';
  return c.json(out);
});

listingRoutes.patch(`/:id{${UUID_PATTERN}}/`, optionalAuthMiddleware(), async (c) => {
  const userId = c.get('userId');
  const listing = await loadListing(c, c.req.param('id'));
  if (!listing || !userId || listing.sellerId !== userId) return notFound(c);
  await assertVerifiedIn(c, listing.regionCode);
  if (listing.adminLocked) apiError(403, 'listing.errAdminLocked');
  const body = await readJson(c.req);
  const db = createDb(c.env.DB);
  const now = nowIso();

  // A manual book's own fields, editable only while this seller is its sole lister.
  const bookUpdate: Partial<typeof books.$inferInsert> = {};
  const bookFieldsSent = ['book_title', 'book_authors', 'isbn'].some((k) => Object.prototype.hasOwnProperty.call(body, k));
  const [book] = await db.select().from(books).where(eq(books.id, listing.bookId)).limit(1);
  if (book && book.source === 'manual' && bookFieldsSent) {
    const [other] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.bookId, book.id), sql`${listings.sellerId} <> ${userId}`))
      .limit(1);
    if (other) apiError(403, 'listing.errBookShared');
    const before = [book.title, book.authors, book.isbn13];
    if (body.book_title !== undefined && body.book_title !== null) {
      if (typeof body.book_title !== 'string' || !body.book_title.trim()) apiError(400, 'sell.errValidation');
      bookUpdate.title = body.book_title.trim().slice(0, 255);
    }
    if (body.book_authors !== undefined && body.book_authors !== null) {
      if (typeof body.book_authors !== 'string') apiError(400, 'sell.errValidation');
      bookUpdate.authors = body.book_authors.trim().slice(0, 512);
    }
    if (body.isbn !== undefined && body.isbn !== null) {
      if (body.isbn === '') bookUpdate.isbn13 = null;
      else {
        const valid = validateBookIsbn(body.isbn);
        if (!valid) apiError(400, 'listing.errInvalidIsbn');
        const [taken] = await db
          .select({ id: books.id })
          .from(books)
          .where(and(eq(books.regionCode, book.regionCode), eq(books.isbn13, valid), sql`${books.id} <> ${book.id}`))
          .limit(1);
        if (taken) apiError(400, 'listing.errIsbnTaken');
        bookUpdate.isbn13 = valid;
      }
    }
    const after = [
      bookUpdate.title ?? book.title,
      bookUpdate.authors ?? book.authors,
      'isbn13' in bookUpdate ? bookUpdate.isbn13 : book.isbn13,
    ];
    if (after.some((v, i) => v !== before[i])) {
      // The admin's "no catalogue has this" was about the old record.
      bookUpdate.reviewedAt = null;
      bookUpdate.reviewedById = null;
    }
  }

  const { values, errors } = await validateListingFields(c.env, body, { regionCode: listing.regionCode, current: listing });
  let photos: string[] | undefined;
  if (!Object.keys(errors).length && Object.prototype.hasOwnProperty.call(body, 'photos')) {
    try {
      photos = await acceptListingPhotos(c.env, origin(c), body.photos, userId, parsePhotos(listing.photos));
    } catch (e) {
      if (!(e instanceof PhotoError)) throw e;
      (errors as FieldErrors).photos = [e.code];
    }
  }
  if (Object.keys(errors).length) fieldErrors(errors);

  const update: Partial<Listing> = { updatedAt: now };
  if (values.bookId !== undefined) update.bookId = values.bookId;
  if (values.price !== undefined) update.price = values.price;
  if (values.condition !== undefined) update.condition = values.condition;
  if (values.privateNote !== undefined) update.privateNote = values.privateNote;
  if (values.description !== undefined) update.description = values.description;
  if (values.categoryId !== undefined) update.categoryId = values.categoryId;
  if (values.status !== undefined) update.status = values.status;
  if (values.courseName !== undefined) update.courseName = values.courseName;
  if (values.professorName !== undefined) update.professorName = values.professorName;
  if (photos !== undefined) update.photos = JSON.stringify(photos);

  // Conditional on the status read above: an order accepted meanwhile
  // (active → reserved) must not be overwritten by this edit.
  const listingStmt = db
    .update(listings)
    .set(update)
    .where(and(eq(listings.id, listing.id), eq(listings.status, listing.status), eq(listings.adminLocked, 0)));
  const results = Object.keys(bookUpdate).length
    ? await db.batch([listingStmt, db.update(books).set(bookUpdate).where(eq(books.id, listing.bookId))])
    : [await listingStmt];
  const changed = (results[0] as unknown as D1Result).meta?.changes ?? 0;
  if (!changed) fieldErrors({ status: ['listing.errStatusNotAllowed'] });

  const fresh = (await loadListing(c, listing.id))!;
  const region = await requireRegion(c);
  const [out] = await serializeListings(c.env, [fresh], { viewerId: userId, lang: resolveLanguage(c, region) });
  return c.json(out);
});

listingRoutes.delete(`/:id{${UUID_PATTERN}}/`, optionalAuthMiddleware(), async (c) => {
  const userId = c.get('userId');
  const listing = await loadListing(c, c.req.param('id'));
  if (!listing || !userId || listing.sellerId !== userId) return notFound(c);
  if (listing.adminLocked) apiError(403, 'listing.errAdminLocked');
  // Finished orders, the chat and reports outlive the listing on their
  // snapshot; an open order still needs it, so it must be finished first.
  if (await hasActiveOrders(c.env, listing.id)) apiError(409, 'listing.errHasActiveOrders');
  // An order opened between the check above and the delete is cancelled
  // rather than left pointing at a listing that is gone.
  await cancelOpenOrdersForListing(c.env, { listingId: listing.id, actorId: userId, reason: 'listing_removed' });
  await deleteListing(c.env, origin(c), listing);
  return c.body(null, 204);
});
