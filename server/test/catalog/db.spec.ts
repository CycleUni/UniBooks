/**
 * Catalog / listings / search / subscriptions / sitemap against D1.
 * Skipped until src/db/migrations carries the current books/listings
 * columns (the lead regenerates the migration from schema.ts).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppEnv } from '../../src/env';
import { errorHandler } from '../../src/middleware/error';
import { signToken } from '../../src/lib/jwt';
import { bookRoutes } from '../../src/routes/books';
import { listingRoutes } from '../../src/routes/listings';
import { searchRoutes } from '../../src/routes/search';
import { subscriptionRoutes } from '../../src/routes/subscriptions';
import { sitemapRoutes } from '../../src/routes/sitemap';

const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('books')`).all<{ name: string }>();
const schemaReady = cols.results.some((c) => c.name === 'authors');

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/api/v1/books', bookRoutes);
app.route('/api/v1/listings', listingRoutes);
app.route('/api/v1/search', searchRoutes);
app.route('/api/v1/subscriptions', subscriptionRoutes);
app.route('/api/v1', sitemapRoutes);

const NOW = '2026-01-01T00:00:00.000Z';
const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const BOOK = '33333333-3333-4333-8333-333333333333';
const BOOK2 = '44444444-4444-4444-8444-444444444444';
const L1 = '55555555-5555-4555-8555-555555555555';
const L2 = '66666666-6666-4666-8666-666666666666';

let sellerAuth: Record<string, string>;
let buyerAuth: Record<string, string>;

async function call(path: string, init: RequestInit & { auth?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Region', 'TW');
  for (const [k, v] of Object.entries(init.auth ?? {})) headers.set(k, v);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return app.fetch(new Request(`http://x${path}`, { ...init, headers }), env);
}

describe.skipIf(!schemaReady)('catalog against D1', () => {
  beforeAll(async () => {
    const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args);
    await env.DB.batch([
      run(`INSERT INTO currencies (code, symbol) VALUES ('TWD', 'NT$')`),
      run(`INSERT INTO languages (code, name) VALUES ('zh-TW', 'Chinese')`),
      run(
        `INSERT INTO regions (code, name, default_currency, default_language, timezone, search_engines, created_at)
         VALUES ('TW', 'Taiwan', 'TWD', 'zh-TW', 'Asia/Taipei', '["googlebooks"]', ?)`,
        NOW,
      ),
      run(`INSERT INTO categories (id, region_code, slug, title) VALUES (1, 'TW', 'eng', 'Engineering')`),
      run(
        `INSERT INTO schools (id, region_code, code, name, email_domain, created_at) VALUES (1, 'TW', 'NTU', 'NTU', 'ntu.edu.tw', ?)`,
        NOW,
      ),
      run(
        `INSERT INTO users (id, email, first_name, last_name, created_at, updated_at) VALUES (?, 's@ntu.edu.tw', 'Sel', 'Ler', ?, ?)`,
        SELLER,
        NOW,
        NOW,
      ),
      run(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, 'b@x.tw', ?, ?)`, BUYER, NOW, NOW),
      run(
        `INSERT INTO region_verifications (user_id, region_code, school_id, verified_at, is_active) VALUES (?, 'TW', 1, ?, 1)`,
        SELLER,
        NOW,
      ),
      run(
        `INSERT INTO books (id, region_code, isbn13, title, authors, publisher, source, created_at)
         VALUES (?, 'TW', '9780131103627', 'The C Programming Language', 'K&R', '"Prentice Hall"', 'manual', ?)`,
        BOOK,
        NOW,
      ),
      run(`INSERT INTO books (id, region_code, title, source, created_at) VALUES (?, 'TW', 'Notes', 'manual', ?)`, BOOK2, NOW),
      run(
        `INSERT INTO listings (id, region_code, currency_code, book_id, seller_id, school_id, price, condition, private_note,
                               category_id, course_name, created_at, updated_at)
         VALUES (?, 'TW', 'TWD', ?, ?, 1, 300, 'noted', 'secret', 1, 'Calculus', ?, ?)`,
        L1,
        BOOK,
        SELLER,
        NOW,
        NOW,
      ),
      run(
        `INSERT INTO listings (id, region_code, currency_code, book_id, seller_id, price, condition, created_at, updated_at)
         VALUES (?, 'TW', 'TWD', ?, ?, 100, 'new', ?, ?)`,
        L2,
        BOOK,
        SELLER,
        '2026-02-01T00:00:00.000Z',
        NOW,
      ),
    ]);
    sellerAuth = { Authorization: `Bearer ${await signToken('access', { user_id: SELLER }, env)}` };
    buyerAuth = { Authorization: `Bearer ${await signToken('access', { user_id: BUYER }, env)}` };
  });

  afterEach(() => vi.restoreAllMocks());

  it('book detail: listings, price stats over every copy, no private note', async () => {
    const res = await call(`/api/v1/books?id=${BOOK}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.publisher).toBe('Prentice Hall');
    expect(body.listings.count).toBe(2);
    expect(body.price_stats).toEqual({ count: 2, min: 100, max: 300 });
    expect(body.listings.results.every((l: Record<string, unknown>) => !('private_note' in l))).toBe(true);
    expect(body.local_listings_count).toBeNull();
    const local = (await (await call(`/api/v1/books?id=${BOOK}&school=NTU`)).json()) as Record<string, any>;
    expect(local.local_listings_count).toBe(1);
  });

  it('book detail 404s cleanly', async () => {
    const res = await call('/api/v1/books?id=not-a-valid-id');
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe('not_found');
    expect((await call('/api/v1/books')).status).toBe(400);
  });

  it('manual create: verified only, unvetted source stays manual, bad cover dropped', async () => {
    const payload = JSON.stringify({ isbn13: '9781285740621', title: 'X', source: 'fake', cover_url: 'javascript:alert(1)' });
    expect((await call('/api/v1/books/manual', { method: 'POST', body: payload, auth: buyerAuth })).status).toBe(403);
    const res = await call('/api/v1/books/manual', { method: 'POST', body: payload, auth: sellerAuth });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ source: 'manual', cover_url: '', isbn13: '9781285740621' });
    expect(body).not.toHaveProperty('reviewed_at');
    // Same ISBN again returns the existing book.
    expect((await call('/api/v1/books/manual', { method: 'POST', body: payload, auth: sellerAuth })).status).toBe(200);
    expect((await call('/api/v1/books/manual', { method: 'POST', body: '{}', auth: sellerAuth })).status).toBe(400);
  });

  it('subscriptions: create, idempotent, list, delete only own', async () => {
    let res = await call('/api/v1/subscriptions', { method: 'POST', body: JSON.stringify({ book_id: BOOK }), auth: buyerAuth });
    expect(res.status).toBe(201);
    const sub = (await res.json()) as Record<string, any>;
    expect(sub).toMatchObject({ book: BOOK, bookTitle: 'The C Programming Language', isbn: '9780131103627', newListingsCount: 0 });
    res = await call('/api/v1/subscriptions', { method: 'POST', body: JSON.stringify({ book_id: BOOK }), auth: buyerAuth });
    expect(res.status).toBe(200);
    const list = (await (await call('/api/v1/subscriptions', { auth: buyerAuth })).json()) as unknown[];
    expect(list).toHaveLength(1);
    const detail = (await (await call(`/api/v1/books?id=${BOOK}`, { auth: buyerAuth })).json()) as Record<string, any>;
    expect(detail).toMatchObject({ is_subscribed: true, subscription_id: sub.id, waiting_count: 1 });
    expect((await call(`/api/v1/subscriptions/${sub.id}`, { method: 'DELETE', auth: sellerAuth })).status).toBe(404);
    expect((await call(`/api/v1/subscriptions/${sub.id}`, { method: 'DELETE', auth: buyerAuth })).status).toBe(204);
    expect((await call('/api/v1/subscriptions', { method: 'POST', body: '{}', auth: buyerAuth })).status).toBe(400);
  });

  it('search: no filters is [], browse by filters and category, facets', async () => {
    expect(await (await call('/api/v1/search/books')).json()).toEqual([]);
    let body = (await (await call('/api/v1/search/books?condition=noted')).json()) as Record<string, any>;
    expect(body.count).toBe(1);
    expect(body.results[0]).toMatchObject({ id: BOOK, activeListings: 2, minPrice: 100 });
    expect(body.facets.condition).toEqual([
      { value: 'new', count: 1 },
      { value: 'like_new', count: 0 },
      { value: 'noted', count: 1 },
      { value: 'damaged', count: 0 },
    ]);
    expect(body.facets.category).toEqual([{ value: 'eng', count: 1 }]);
    expect(body.facets.course).toEqual([{ value: 'Calculus', count: 1 }]);
    body = (await (await call('/api/v1/search/books?category=eng&school=NTU')).json()) as Record<string, any>;
    expect(body).toMatchObject({ count: 1, scope: 'school', local_count: 1 });
    body = (await (await call('/api/v1/search/books?price_min=150&in_stock=1')).json()) as Record<string, any>;
    expect(body.count).toBe(0);
    body = (await (await call('/api/v1/search/books?condition=none')).json()) as Record<string, any>;
    expect(body.count).toBe(0);
  });

  it('search: keyword merges local books with the catalogue', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        totalItems: 1,
        items: [
          {
            volumeInfo: {
              title: 'Other Book',
              authors: ['A'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9789999999990' }],
            },
          },
        ],
      }),
    );
    const res = await call('/api/v1/search/books?q=calculus');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    const byIsbn = Object.fromEntries(body.results.map((r: any) => [r.isbn, r]));
    // Matched by its listing's course name.
    expect(byIsbn['9780131103627']).toMatchObject({ id: BOOK, activeListings: 2, conditions: expect.any(Array) });
    expect(body.facets.course).toEqual([{ value: 'Calculus', count: 1 }]);
  });

  it('courses', async () => {
    const res = await call('/api/v1/search/courses');
    expect(await res.json()).toEqual([{ value: 'Calculus', count: 1 }]);
  });

  it('listings feed is public and strips the private note; the seller sees it on detail', async () => {
    const feed = (await (await call('/api/v1/listings')).json()) as Record<string, any>;
    expect(feed.count).toBe(2);
    expect(feed.results[0].id).toBe(L2); // newest first
    expect(feed.results.every((l: any) => !('private_note' in l))).toBe(true);
    const own = (await (await call(`/api/v1/listings/${L1}`, { auth: sellerAuth })).json()) as Record<string, any>;
    expect(own.private_note).toBe('secret');
    const other = (await (await call(`/api/v1/listings/${L1}`, { auth: buyerAuth })).json()) as Record<string, any>;
    expect(other).not.toHaveProperty('private_note');
    const recent = (await (await call('/api/v1/listings/recent-books')).json()) as Record<string, any>;
    expect(recent.results[0]).toMatchObject({ id: BOOK, min_price: 100, max_price: 300 });
  });

  it('listing create: verified only, foreign photo keys refused', async () => {
    const base = { book: BOOK2, price: 50, condition: 'new' };
    expect((await call('/api/v1/listings', { method: 'POST', body: JSON.stringify(base), auth: buyerAuth })).status).toBe(403);
    const r2Base = (env.R2_PUBLIC_URL || 'http://x/media').replace(/\/+$/, '');
    let res = await call('/api/v1/listings', {
      method: 'POST',
      body: JSON.stringify({ ...base, photos: [`${r2Base}/tmp/listings/${BUYER}/${'c'.repeat(32)}.jpg`] }),
      auth: sellerAuth,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.fields.photos).toEqual(['listing.errPhotoNotOwned']);
    res = await call('/api/v1/listings', { method: 'POST', body: JSON.stringify(base), auth: sellerAuth });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, any>;
    expect(created).toMatchObject({ seller: SELLER, school: 1, currency: 'TWD', status: 'active' });
  });

  it('listing patch/delete: only the seller; delete keeps order history', async () => {
    expect((await call(`/api/v1/listings/${L2}`, { method: 'PATCH', body: '{"price":120}', auth: buyerAuth })).status).toBe(404);
    const res = await call(`/api/v1/listings/${L2}`, { method: 'PATCH', body: '{"price":120}', auth: sellerAuth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).price).toBe(120);

    const order = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO orders (id, region_code, currency_code, listing_id, book_title, buyer_id, seller_id, status, total_amount, created_at, updated_at)
       VALUES (?, 'TW', 'TWD', ?, 'The C Programming Language', ?, ?, 'completed', 120, ?, ?)`,
    )
      .bind(order, L2, BUYER, SELLER, NOW, NOW)
      .run();
    expect((await call(`/api/v1/listings/${L2}`, { method: 'DELETE', auth: buyerAuth })).status).toBe(404);
    expect((await call(`/api/v1/listings/${L2}`, { method: 'DELETE', auth: sellerAuth })).status).toBe(204);
    const row = await env.DB.prepare(`SELECT listing_id, listing_ref, book_title FROM orders WHERE id = ?`).bind(order).first();
    expect(row).toEqual({ listing_id: null, listing_ref: L2, book_title: 'The C Programming Language' });
  });

  it('sitemap index and sections', async () => {
    let res = await call('/api/v1/sitemap.xml');
    expect(res.headers.get('Content-Type')).toMatch(/^application\/xml/);
    const index = await res.text();
    expect(index).toContain('http://x/api/v1/sitemap/books-tw-1.xml');
    expect(index).toContain('http://x/api/v1/sitemap/listings-tw-1.xml');
    res = await call('/api/v1/sitemap/books-tw-1.xml');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/tw/book?isbn=9780131103627');
    expect((await call('/api/v1/sitemap/books-tw-2.xml')).status).toBe(404);
    expect((await call('/api/v1/sitemap/books-hk-1.xml')).status).toBe(404);
  });
});
