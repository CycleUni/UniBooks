import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { books, createDb, listings, type Book, type Listing } from '../../src/db';
import type { AppEnv } from '../../src/env';
import { errorHandler } from '../../src/middleware/error';
import { bookRoutes } from '../../src/routes/books';
import { listingRoutes } from '../../src/routes/listings';
import { searchRoutes } from '../../src/routes/search';
import { adminRoutes } from '../../src/routes/admin';
import { copyBookCover, coverUrlFor, runCoverCleanup, runCoverSweep } from '../../src/services/catalog/covers';
import { runCleanup } from '../../src/jobs/index';
import { UNUSED_BOOK_GRACE_MS } from '../../src/services/catalog/unused';
import { deleteListing } from '../../src/services/listings/lifecycle';
import { seedRegion, seedUser } from '../messaging/helpers';
import { staff } from '../ads/helpers';

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/api/v1/books', bookRoutes);
app.route('/api/v1/listings', listingRoutes);
app.route('/api/v1/search', searchRoutes);
app.route('/api/v1/admin', adminRoutes);

const NOW = () => new Date().toISOString();
const GOOGLE_COVER = 'https://books.google.com/books/content?id=test1234&printsec=frontcover&img=1&zoom=1';
const OPEN_LIBRARY_COVER = 'https://covers.openlibrary.org/b/id/12345-L.jpg';

// A valid 5000-byte JPEG image
function fakeJpegBytes(size = 5000): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  return bytes;
}

function fakeJpegResponse(size = 5000, maxAge = 86400): Response {
  return new Response(fakeJpegBytes(size), {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': `public, max-age=${maxAge}`,
    },
  });
}

function fakePlaceholderResponse(): Response {
  // Google Books placeholder: max-age=30
  return new Response(fakeJpegBytes(4000), {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=30',
    },
  });
}

describe('R2 Cover Cache and Lifecycle', () => {
  let seller: { id: string; token: string };
  let admin: { id: string; token: string };
  const db = createDb(env.DB);

  beforeEach(async () => {
    await db.delete(listings);
    await db.delete(books);
    await seedRegion('TW');
    seller = await seedUser({ verifiedIn: 'TW' });
    admin = await staff(`admin-${crypto.randomUUID().slice(0, 8)}@example.com`, { admin: true, regions: ['TW'] });
  });

  async function createTestBook(coverUrl = GOOGLE_COVER, source: Book['source'] = 'google_api'): Promise<Book> {
    const id = crypto.randomUUID();
    const row: Book = {
      id,
      regionCode: 'TW',
      isbn13: '978' + Math.floor(1000000000 + Math.random() * 9000000000),
      title: `Book ${id.slice(0, 6)}`,
      authors: 'Author',
      publisher: 'Publisher',
      publishedDate: '2026',
      coverUrl,
      coverR2Key: null,
      coverCheckedAt: null,
      source,
      createdAt: NOW(),
      reviewedAt: null,
      reviewedById: null,
    };
    await db.insert(books).values(row);
    return row;
  }

  async function createTestListing(bookId: string, status: Listing['status'] = 'active'): Promise<Listing> {
    const id = crypto.randomUUID();
    const row: Listing = {
      id,
      regionCode: 'TW',
      currencyCode: 'TWD',
      bookId,
      sellerId: seller.id,
      schoolId: null,
      price: 300,
      condition: 'like_new',
      privateNote: '',
      description: 'Desc',
      photos: '[]',
      categoryId: null,
      status,
      adminLocked: 0,
      adminLockReason: '',
      lockedById: null,
      lockedAt: null,
      courseName: '',
      professorName: '',
      createdAt: NOW(),
      updatedAt: NOW(),
    };
    await db.insert(listings).values(row);
    return row;
  }

  // ---------------------------------------------------------------------------
  // 1. Copy for a listed book only
  // ---------------------------------------------------------------------------
  it('copies cover to R2 only when the book has an active or reserved listing', async () => {
    const book = await createTestBook(GOOGLE_COVER);
    const fetchStub = vi.fn(async () => fakeJpegResponse());

    // No listing at all: copyBookCover must return false and not store anything
    const copiedWithoutListing = await copyBookCover(env, 'https://unibooks.app', book.id, { fetch: fetchStub });
    expect(copiedWithoutListing).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();

    const [unlistedBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(unlistedBook.coverR2Key).toBeNull();

    // Listing with status 'removed' or 'sold': still not a listed book
    const removedListing = await createTestListing(book.id, 'removed');
    const copiedWithRemoved = await copyBookCover(env, 'https://unibooks.app', book.id, { fetch: fetchStub });
    expect(copiedWithRemoved).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();

    // Update listing to 'active': now it is a listed book
    await db.update(listings).set({ status: 'active' }).where(eq(listings.id, removedListing.id));
    const copiedActive = await copyBookCover(env, 'https://unibooks.app', book.id, { fetch: fetchStub });
    expect(copiedActive).toBe(true);
    expect(fetchStub).toHaveBeenCalled();

    const [activeBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(activeBook.coverR2Key).toMatch(new RegExp(`^covers/${book.id}-[0-9a-f]{10}\\.jpg$`));
    expect(activeBook.coverCheckedAt).not.toBeNull();

    // Verify stored in R2 bucket with right Content-Type
    const r2Object = await env.R2.get(activeBook.coverR2Key!);
    expect(r2Object).not.toBeNull();
    expect(r2Object?.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('allows copying when listing is reserved', async () => {
    const book = await createTestBook(OPEN_LIBRARY_COVER);
    await createTestListing(book.id, 'reserved');
    const fetchStub = vi.fn(async () => fakeJpegResponse());

    const ok = await copyBookCover(env, 'https://unibooks.app', book.id, { fetch: fetchStub });
    expect(ok).toBe(true);

    const [row] = await db.select().from(books).where(eq(books.id, book.id));
    expect(row.coverR2Key).toMatch(new RegExp(`^covers/${book.id}-[0-9a-f]{10}\\.jpg$`));
  });

  // ---------------------------------------------------------------------------
  // 2. Placeholder/no-cover not stored and not retried before the interval
  // ---------------------------------------------------------------------------
  it('does not store placeholder or 404 and does not retry before the interval', async () => {
    const book = await createTestBook(GOOGLE_COVER);
    await createTestListing(book.id, 'active');

    // Upstream returns Google Books placeholder (max-age=30)
    const fetchStub = vi.fn(async () => fakePlaceholderResponse());
    const firstAttempt = await copyBookCover(env, 'https://unibooks.app', book.id, { fetch: fetchStub });
    expect(firstAttempt).toBe(false);
    expect(fetchStub).toHaveBeenCalled();

    const [checkedBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(checkedBook.coverR2Key).toBeNull();
    expect(checkedBook.coverCheckedAt).not.toBeNull();

    // R2 has no object
    expect((await env.R2.list({ prefix: `covers/${book.id}` })).objects).toHaveLength(0);

    // Second attempt within 7 days: should skip fetch entirely
    fetchStub.mockClear();
    const secondAttempt = await copyBookCover(env, 'https://unibooks.app', book.id, { fetch: fetchStub });
    expect(secondAttempt).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();

    // Simulate interval passing (8 days ago)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await db.update(books).set({ coverCheckedAt: eightDaysAgo }).where(eq(books.id, book.id));

    // Now it retries! Provide a valid cover
    fetchStub.mockImplementation(async () => fakeJpegResponse());
    const retryAttempt = await copyBookCover(env, 'https://unibooks.app', book.id, { fetch: fetchStub });
    expect(retryAttempt).toBe(true);
    expect(fetchStub).toHaveBeenCalled();

    const [finalBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(finalBook.coverR2Key).toMatch(new RegExp(`^covers/${book.id}-[0-9a-f]{10}\\.jpg$`));
  });

  it('does not stamp 7-day cooldown on transient upstream 5xx or network errors', async () => {
    const book = await createTestBook(GOOGLE_COVER);
    await createTestListing(book.id, 'active');

    const fetchStub = vi.fn(async () => new Response(null, { status: 503 }));
    const ok = await copyBookCover(env, 'https://unibooks.app', book.id, { fetch: fetchStub });
    expect(ok).toBe(false);

    const [row] = await db.select().from(books).where(eq(books.id, book.id));
    expect(row.coverR2Key).toBeNull();
    // coverCheckedAt is NOT stamped on transient failures, so it can retry next run
    expect(row.coverCheckedAt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 3. API returns the R2 URL when stored and original otherwise
  // ---------------------------------------------------------------------------
  it('helper coverUrlFor and endpoints return R2 URL when stored, original otherwise', async () => {
    const book = await createTestBook('https://books.google.com/test?zoom=1');
    const origin = 'https://unibooks.app';

    // Without R2 copy: returns original cover_url
    expect(coverUrlFor(env, origin, book)).toBe('https://books.google.com/test?zoom=1');

    // With R2 copy: returns R2 URL
    const r2Key = `covers/${book.id}.jpg`;
    const bookWithR2 = { ...book, coverR2Key: r2Key };
    const expectedR2Url = env.R2_PUBLIC_URL ? `${env.R2_PUBLIC_URL}/${r2Key}` : `${origin}/api/media/${r2Key}`;
    expect(coverUrlFor(env, origin, bookWithR2)).toBe(expectedR2Url);

    // Endpoint test: GET /api/v1/books?id=
    await createTestListing(book.id, 'active');
    const req1 = new Request(`http://x/api/v1/books?id=${book.id}`, { headers: { 'X-Region': 'TW' } });
    const res1 = await app.fetch(req1, env);
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as Record<string, unknown>;
    expect(json1.cover_url).toBe('https://books.google.com/test?zoom=1');

    // Set cover_r2_key in D1 and re-fetch
    await db.update(books).set({ coverR2Key: r2Key }).where(eq(books.id, book.id));
    const req2 = new Request(`http://x/api/v1/books?id=${book.id}`, { headers: { 'X-Region': 'TW' } });
    const res2 = await app.fetch(req2, env);
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as Record<string, unknown>;
    expect(json2.cover_url).toBe(expectedR2Url);
  });

  // ---------------------------------------------------------------------------
  // 4. Cleanup removes copies of unlisted books, on cover_url change, on book purge
  // ---------------------------------------------------------------------------
  it('cron sweep removes copies of unlisted books and never touches outside covers/', async () => {
    const book = await createTestBook();
    const listing = await createTestListing(book.id, 'active');

    // Put R2 object and update DB
    const coverKey = `covers/${book.id}.jpg`;
    await env.R2.put(coverKey, fakeJpegBytes());
    await db.update(books).set({ coverR2Key: coverKey }).where(eq(books.id, book.id));

    // Also put an unrelated photo outside covers/ to ensure it is untouched
    const photoKey = 'listings/u1/photo.jpg';
    await env.R2.put(photoKey, fakeJpegBytes());

    // While listing is active: runCoverCleanup removes nothing
    const cleanActive = await runCoverCleanup(env);
    expect(cleanActive.cleaned).toBe(0);
    expect(await env.R2.get(coverKey)).not.toBeNull();
    expect(await env.R2.get(photoKey)).not.toBeNull();

    // Listing becomes sold: book is no longer listed
    await db.update(listings).set({ status: 'sold' }).where(eq(listings.id, listing.id));

    // Run cleanup sweep
    const cleanSold = await runCoverCleanup(env);
    expect(cleanSold.cleaned).toBe(1);

    // R2 cover is deleted, DB column is cleared
    expect(await env.R2.get(coverKey)).toBeNull();
    const [cleanedBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(cleanedBook.coverR2Key).toBeNull();

    // Unrelated photo outside covers/ is completely untouched!
    expect(await env.R2.get(photoKey)).not.toBeNull();
  });

  it('drops stale copy when cover_url changes via admin edit', async () => {
    const book = await createTestBook('https://books.google.com/old?zoom=1');
    await createTestListing(book.id, 'active');

    const coverKey = `covers/${book.id}.jpg`;
    await env.R2.put(coverKey, fakeJpegBytes());
    await db.update(books).set({ coverR2Key: coverKey }).where(eq(books.id, book.id));

    // Admin updates cover_url
    const newCover = 'https://covers.openlibrary.org/b/id/99999-L.jpg';
    const req = new Request(`http://x/api/v1/admin/books/${book.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin.token}`,
      },
      body: JSON.stringify({ cover_url: newCover }),
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);

    // Old R2 copy deleted and coverR2Key cleared
    expect(await env.R2.get(coverKey)).toBeNull();
    const [updatedBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(updatedBook.coverR2Key).toBeNull();
    expect(updatedBook.coverUrl).toBe(newCover);
  });

  it('drops stale copy when cover_url changes via manual book edit in listings', async () => {
    const book = await createTestBook('https://books.google.com/old?zoom=1', 'manual');
    const listing = await createTestListing(book.id, 'active');

    const coverKey = `covers/${book.id}.jpg`;
    await env.R2.put(coverKey, fakeJpegBytes());
    await db.update(books).set({ coverR2Key: coverKey }).where(eq(books.id, book.id));

    // Seller updates cover_url
    const newCover = 'https://covers.openlibrary.org/b/id/77777-L.jpg';
    const req = new Request(`http://x/api/v1/listings/${listing.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${seller.token}`,
        'X-Region': 'TW',
      },
      body: JSON.stringify({ cover_url: newCover }),
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);

    expect(await env.R2.get(coverKey)).toBeNull();
    const [updatedBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(updatedBook.coverR2Key).toBeNull();
    expect(updatedBook.coverUrl).toBe(newCover);
  });

  it('removes R2 cover when orphan book is purged in daily cleanup job', async () => {
    // Book with no listings and no subscriptions, past the grace period
    const book = await createTestBook();
    const coverKey = `covers/${book.id}.jpg`;
    await env.R2.put(coverKey, fakeJpegBytes());
    await db
      .update(books)
      .set({ coverR2Key: coverKey, createdAt: new Date(Date.now() - UNUSED_BOOK_GRACE_MS - 60_000).toISOString() })
      .where(eq(books.id, book.id));

    // Daily cleanup purge
    const result = await runCleanup(env);
    expect(result.orphan_books_deleted).toBeGreaterThanOrEqual(1);

    // R2 cover must be deleted
    expect(await env.R2.get(coverKey)).toBeNull();
  });

  it('removes R2 cover when deleteListing removes the book', async () => {
    const book = await createTestBook();
    const listing = await createTestListing(book.id, 'active');
    const coverKey = `covers/${book.id}.jpg`;
    await env.R2.put(coverKey, fakeJpegBytes());
    await db.update(books).set({ coverR2Key: coverKey }).where(eq(books.id, book.id));

    await deleteListing(env, 'https://unibooks.app', listing);

    // Book is gone from D1 and cover is deleted from R2
    const [row] = await db.select().from(books).where(eq(books.id, book.id));
    expect(row).toBeUndefined();
    expect(await env.R2.get(coverKey)).toBeNull();
  });

  it('cron sweep copies missing covers for listed books oldest first', async () => {
    const b1 = await createTestBook('https://books.google.com/b1?zoom=1');
    const b2 = await createTestBook('https://books.google.com/b2?zoom=1');
    await createTestListing(b1.id, 'active');
    await createTestListing(b2.id, 'active');

    // Make b1 older than b2
    const older = new Date(Date.now() - 100000).toISOString();
    await db.update(books).set({ createdAt: older }).where(eq(books.id, b1.id));

    const fetchOrder: string[] = [];
    const fetchStub = vi.fn(async (url: string) => {
      fetchOrder.push(url);
      return fakeJpegResponse();
    });

    const sweepResult = await runCoverSweep(env, 20, fetchStub);
    expect(sweepResult.copied).toBe(2);

    // Verify b1 was requested first (oldest first)
    expect(fetchOrder[0]).toContain('b1');
    expect(fetchOrder[1]).toContain('b2');

    const [row1] = await db.select().from(books).where(eq(books.id, b1.id));
    const [row2] = await db.select().from(books).where(eq(books.id, b2.id));
    expect(row1.coverR2Key).toMatch(new RegExp(`^covers/${b1.id}-[0-9a-f]{10}\\.jpg$`));
    expect(row2.coverR2Key).toMatch(new RegExp(`^covers/${b2.id}-[0-9a-f]{10}\\.jpg$`));
  });
});
