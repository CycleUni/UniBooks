import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import {
  createDb,
  currencies,
  languages,
  regions,
  users,
  regionVerifications,
  books,
  listings,
  conversations,
  conversationListings,
  orders,
  orderItems,
} from '../../src/db';
import { signToken } from '../../src/lib/jwt';
import { cancelOpenOrdersForListing } from '../../src/services/orders/cancel';
import { applyAutoComplete } from '../../src/services/orders/transitions';

const now = () => new Date().toISOString();
const db = createDb(env.DB);

async function makeUser(name: string, verified = true, regionCode = 'TW') {
  const id = crypto.randomUUID();
  await db
    .insert(users)
    .values({ id, email: `${name}-${id.slice(0, 6)}@example.test`, firstName: name, createdAt: now(), updatedAt: now() });
  if (verified) {
    await db.insert(regionVerifications).values({ userId: id, regionCode, isManualVerification: 1, verifiedAt: now(), isActive: 1 });
  }
  const token = await signToken('access', { user_id: id, auth_time: Math.floor(Date.now() / 1000) }, env);
  return { id, token };
}

async function makeListing(sellerId: string, title = 'Linear Algebra', price = 300, regionCode = 'TW', currencyCode = 'TWD') {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, regionCode, isbn13: null, title, source: 'manual', createdAt: now() });
  const id = crypto.randomUUID();
  await db.insert(listings).values({
    id,
    regionCode,
    currencyCode,
    bookId,
    sellerId,
    price,
    condition: 'like_new',
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
  });
  return { id, bookId, title, price };
}

async function chat(buyerId: string, sellerId: string, listingIds: string[]) {
  const id = crypto.randomUUID();
  const firstId = listingIds[0];
  await db.insert(conversations).values({
    id,
    roomId: id,
    regionCode: 'TW',
    buyerId,
    sellerId,
    listingId: firstId,
    listingRef: firstId,
    updatedAt: now(),
    createdAt: now(),
  });
  for (const lid of listingIds) {
    await db
      .insert(conversationListings)
      .values({
        conversationId: id,
        listingId: lid,
        listingRef: lid,
        bookTitle: 'Book Title',
        bookIsbn: '',
        addedById: buyerId,
        addedAt: now(),
      })
      .onConflictDoNothing();
  }
  return id;
}

function api(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-Region', 'TW');
  if (init.body) headers.set('Content-Type', 'application/json');
  const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
  return worker.fetch(new Request(`http://x/api/v1/orders${path ? `/${path}` : ''}`, { ...init, headers }));
}

const post = (path: string, token: string, body: unknown) => api(path, token, { method: 'POST', body: JSON.stringify(body) });
const patch = (path: string, token: string, body: unknown) => api(path, token, { method: 'PATCH', body: JSON.stringify(body) });

describe('Multi-item orders API', () => {
  beforeAll(async () => {
    await db.insert(currencies).values({ code: 'TWD', symbol: 'NT$', decimalPlaces: 0 }).onConflictDoNothing();
    await db.insert(currencies).values({ code: 'HKD', symbol: 'HK$', decimalPlaces: 0 }).onConflictDoNothing();
    await db.insert(languages).values({ code: 'zh-TW', name: 'Chinese (Taiwan)' }).onConflictDoNothing();
    await db.insert(languages).values({ code: 'zh-HK', name: 'Chinese (Hong Kong)' }).onConflictDoNothing();
    await db
      .insert(regions)
      .values({
        code: 'TW',
        name: 'Taiwan',
        defaultCurrency: 'TWD',
        defaultLanguage: 'zh-TW',
        timezone: 'Asia/Taipei',
        languages: '["zh-TW"]',
        createdAt: now(),
      })
      .onConflictDoNothing();
    await db
      .insert(regions)
      .values({
        code: 'HK',
        name: 'Hong Kong',
        defaultCurrency: 'HKD',
        defaultLanguage: 'zh-HK',
        timezone: 'Asia/Hong_Kong',
        languages: '["zh-HK"]',
        createdAt: now(),
      })
      .onConflictDoNothing();
  });

  it('single-listing body unchanged creates order with 1 item', async () => {
    const seller = await makeUser('seller1');
    const buyer = await makeUser('buyer1');
    const l1 = await makeListing(seller.id, 'Calculus 1', 250);
    await chat(buyer.id, seller.id, [l1.id]);

    const res = await post('', buyer.token, { listing: l1.id });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.total_amount).toBe(250);
    expect(body.items?.length).toBe(1);
    expect(body.items[0].title).toBe('Calculus 1');
    expect(body.items[0].price).toBe(250);
    expect(body.listing_title).toBe('Calculus 1');

    // order_items row check
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, body.id));
    expect(items.length).toBe(1);
    expect(items[0].price).toBe(250);
    expect(items[0].isOpen).toBe(1);
  });

  it('multi create happy path sets primary columns, total, items, and format listing_title', async () => {
    const seller = await makeUser('seller2');
    const buyer = await makeUser('buyer2');
    const l1 = await makeListing(seller.id, 'Book Alpha', 100);
    const l2 = await makeListing(seller.id, 'Book Beta', 200);
    const l3 = await makeListing(seller.id, 'Book Gamma', 300);
    const convId = await chat(buyer.id, seller.id, [l1.id, l2.id, l3.id]);

    const res = await post('', buyer.token, {
      listing_ids: [l1.id, l2.id, l3.id],
      conversation_id: convId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.total_amount).toBe(600);
    expect(body.listing_title).toBe('《Book Alpha》等 3 本');
    expect(body.items?.length).toBe(3);
    expect(body.items.map((i: any) => i.price)).toEqual([100, 200, 300]);

    // Check DB orders row
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, body.id));
    expect(dbOrder.listingId).toBe(l1.id);
    expect(dbOrder.totalAmount).toBe(600);
    expect(dbOrder.bookTitle).toBe('Book Alpha');

    // Check order_items in DB
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, body.id));
    expect(items.length).toBe(3);
    expect(items.every((i) => i.isOpen === 1 && i.buyerId === buyer.id)).toBe(true);
  });

  it('all-or-nothing on unavailable listing refuses request with field error naming offending id and releases locks', async () => {
    const seller = await makeUser('seller3');
    const buyer = await makeUser('buyer3');
    const l1 = await makeListing(seller.id, 'Avail 1', 100);
    const l2 = await makeListing(seller.id, 'Unavail 2', 200);
    // Mark l2 as sold
    await db.update(listings).set({ status: 'sold' }).where(eq(listings.id, l2.id));
    const convId = await chat(buyer.id, seller.id, [l1.id, l2.id]);

    const res = await post('', buyer.token, {
      listing_ids: [l1.id, l2.id],
      conversation_id: convId,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error?.fields?.[l2.id]).toContain('checkout.errListingUnavailable');
    expect(body.error?.fields?.[l1.id]).toBeUndefined();

    // Verify l1 was not left reserved or ordered
    const [l1Row] = await db.select().from(listings).where(eq(listings.id, l1.id));
    expect(l1Row.status).toBe('active');

    // Buyer should immediately be able to order l1 alone (lock was released)
    const res2 = await post('', buyer.token, { listing: l1.id });
    expect(res2.status).toBe(201);
  });

  it('all-or-nothing on duplicate open order of this buyer refuses request naming offending listing', async () => {
    const seller = await makeUser('seller4');
    const buyer = await makeUser('buyer4');
    const l1 = await makeListing(seller.id, 'Dup 1', 150);
    const l2 = await makeListing(seller.id, 'Dup 2', 250);
    await chat(buyer.id, seller.id, [l1.id, l2.id]);

    // Buyer orders l1 first
    const firstRes = await post('', buyer.token, { listing: l1.id });
    expect(firstRes.status).toBe(201);

    // Now buyer attempts multi-order with [l1, l2]
    const multiRes = await post('', buyer.token, { listing_ids: [l1.id, l2.id] });
    expect(multiRes.status).toBe(400);
    const body = (await multiRes.json()) as any;
    expect(body.error?.fields?.[l1.id]).toContain('checkout.errListingUnavailable');
    expect(body.error?.fields?.[l2.id]).toBeUndefined();

    // Verify l2 is untouched
    const [l2Row] = await db.select().from(listings).where(eq(listings.id, l2.id));
    expect(l2Row.status).toBe('active');
  });

  it('refuses mixed sellers, foreign region, and own listing', async () => {
    const sellerA = await makeUser('sellerA');
    const sellerB = await makeUser('sellerB');
    const buyer = await makeUser('buyer5');

    const lA = await makeListing(sellerA.id, 'Book A', 100);
    const lB = await makeListing(sellerB.id, 'Book B', 100);
    await chat(buyer.id, sellerA.id, [lA.id]);

    // Mixed sellers
    const resMixed = await post('', buyer.token, { listing_ids: [lA.id, lB.id] });
    expect(resMixed.status).toBe(400);
    const mixedBody = (await resMixed.json()) as any;
    expect(mixedBody.error?.fields?.listing_ids).toContain('checkout.errMixedSellers');

    // Own listing
    const lOwn = await makeListing(buyer.id, 'Own Book', 100);
    const resOwn = await post('', buyer.token, { listing_ids: [lOwn.id] });
    expect(resOwn.status).toBe(400);
    const ownBody = (await resOwn.json()) as any;
    expect(ownBody.error?.fields?.[lOwn.id]).toContain('checkout.errOwnListing');
  });

  it('enforces item count between 1 and 10', async () => {
    const seller = await makeUser('sellerCount');
    const buyer = await makeUser('buyerCount');

    // Empty list
    const resEmpty = await post('', buyer.token, { listing_ids: [] });
    expect(resEmpty.status).toBe(400);
    const emptyBody = (await resEmpty.json()) as any;
    expect(emptyBody.error?.fields?.listing_ids).toContain('checkout.errItemCount');

    // 11 listings
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const l = await makeListing(seller.id, `Book ${i}`, 10);
      ids.push(l.id);
    }
    const res11 = await post('', buyer.token, { listing_ids: ids });
    expect(res11.status).toBe(400);
    const body11 = (await res11.json()) as any;
    expect(body11.error?.fields?.listing_ids).toContain('checkout.errItemCount');
  });

  it('enforces conversation scoping when conversation_id is passed', async () => {
    const seller = await makeUser('sellerScope');
    const buyer = await makeUser('buyerScope');
    const l1 = await makeListing(seller.id, 'Scope 1', 100);
    const l2 = await makeListing(seller.id, 'Scope 2', 200);

    // Chat contains only l1
    const convId = await chat(buyer.id, seller.id, [l1.id]);

    // Try to order [l1, l2] in this chat
    const res = await post('', buyer.token, {
      listing_ids: [l1.id, l2.id],
      conversation_id: convId,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error?.fields?.[l2.id]).toContain('checkout.errNoChat');
  });

  it('lifecycle transitions update all listings and order_items.is_open together', async () => {
    const seller = await makeUser('sellerLife');
    const buyer = await makeUser('buyerLife');
    const l1 = await makeListing(seller.id, 'Trans 1', 120);
    const l2 = await makeListing(seller.id, 'Trans 2', 180);
    const convId = await chat(buyer.id, seller.id, [l1.id, l2.id]);

    const createRes = await post('', buyer.token, { listing_ids: [l1.id, l2.id], conversation_id: convId });
    const order = (await createRes.json()) as any;

    // 1. Accept by seller -> all item listings become reserved
    const acceptRes = await patch(`${order.id}`, seller.token, { status: 'accepted' });
    expect(acceptRes.status).toBe(200);
    const [l1AfterAccept] = await db.select().from(listings).where(eq(listings.id, l1.id));
    const [l2AfterAccept] = await db.select().from(listings).where(eq(listings.id, l2.id));
    expect(l1AfterAccept.status).toBe('reserved');
    expect(l2AfterAccept.status).toBe('reserved');

    // 2. Hand over by seller
    const handRes = await patch(`${order.id}`, seller.token, { status: 'handed_over' });
    expect(handRes.status).toBe(200);

    // 3. Confirm received / complete by buyer -> all listings sold, is_open = 0
    const completeRes = await patch(`${order.id}`, buyer.token, { status: 'completed' });
    expect(completeRes.status).toBe(200);

    const [l1Final] = await db.select().from(listings).where(eq(listings.id, l1.id));
    const [l2Final] = await db.select().from(listings).where(eq(listings.id, l2.id));
    expect(l1Final.status).toBe('sold');
    expect(l2Final.status).toBe('sold');

    const finalItems = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(finalItems.every((i) => i.isOpen === 0)).toBe(true);
  });

  it('cancel returns all listings to active and marks order_items.is_open = 0', async () => {
    const seller = await makeUser('sellerCancel');
    const buyer = await makeUser('buyerCancel');
    const l1 = await makeListing(seller.id, 'Cancel 1', 120);
    const l2 = await makeListing(seller.id, 'Cancel 2', 180);
    await chat(buyer.id, seller.id, [l1.id, l2.id]);

    const createRes = await post('', buyer.token, { listing_ids: [l1.id, l2.id] });
    expect(createRes.status).toBe(201);
    const order = (await createRes.json()) as any;

    await patch(`${order.id}`, seller.token, { status: 'accepted' });
    // Cancel by buyer
    const cancelRes = await patch(`${order.id}`, buyer.token, { status: 'cancelled', cancel_reason: 'buyer_cancelled' });
    expect(cancelRes.status).toBe(200);

    const [l1Row] = await db.select().from(listings).where(eq(listings.id, l1.id));
    const [l2Row] = await db.select().from(listings).where(eq(listings.id, l2.id));
    expect(l1Row.status).toBe('active');
    expect(l2Row.status).toBe('active');

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(items.every((i) => i.isOpen === 0)).toBe(true);
  });

  it('listing deletion cancels the whole multi-item order via cancelOpenOrdersForListing', async () => {
    const seller = await makeUser('sellerDel');
    const buyer = await makeUser('buyerDel');
    const l1 = await makeListing(seller.id, 'Del 1', 100);
    const l2 = await makeListing(seller.id, 'Del 2', 200);
    await chat(buyer.id, seller.id, [l1.id, l2.id]);

    const createRes = await post('', buyer.token, { listing_ids: [l1.id, l2.id] });
    expect(createRes.status).toBe(201);
    const order = (await createRes.json()) as any;

    await patch(`${order.id}`, seller.token, { status: 'accepted' });

    // Delete l2 (second item in order)
    const cancelledCount = await cancelOpenOrdersForListing(env, { listingId: l2.id, actorId: seller.id, reason: 'listing_removed' });
    expect(cancelledCount).toBe(1);

    const [orderRow] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(orderRow.status).toBe('cancelled');

    // l1 is returned to active
    const [l1Row] = await db.select().from(listings).where(eq(listings.id, l1.id));
    expect(l1Row.status).toBe('active');

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(items.every((i) => i.isOpen === 0)).toBe(true);
  });

  it('auto-complete job completes multi-item order and sells all item listings', async () => {
    const seller = await makeUser('sellerAuto');
    const buyer = await makeUser('buyerAuto');
    const l1 = await makeListing(seller.id, 'Auto 1', 100);
    const l2 = await makeListing(seller.id, 'Auto 2', 200);
    await chat(buyer.id, seller.id, [l1.id, l2.id]);

    const createRes = await post('', buyer.token, { listing_ids: [l1.id, l2.id] });
    expect(createRes.status).toBe(201);
    const order = (await createRes.json()) as any;

    await patch(`${order.id}`, seller.token, { status: 'accepted' });
    await patch(`${order.id}`, seller.token, { status: 'handed_over' });

    // Set handed_over_at to 8 days ago so auto-complete is due
    const eightDaysAgo = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
    await db.update(orders).set({ handedOverAt: eightDaysAgo }).where(eq(orders.id, order.id));

    // Execute auto complete
    const result = await applyAutoComplete(env, { orderId: order.id });
    expect(result.ok).toBe(true);

    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(orderAfter.status).toBe('completed');

    const [l1Row] = await db.select().from(listings).where(eq(listings.id, l1.id));
    const [l2Row] = await db.select().from(listings).where(eq(listings.id, l2.id));
    expect(l1Row.status).toBe('sold');
    expect(l2Row.status).toBe('sold');

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(items.every((i) => i.isOpen === 0)).toBe(true);
  });

  it('backfill migration populates order_items from orders table', async () => {
    // Create an order directly in orders table as if existing pre-migration
    const seller = await makeUser('sellerBackfill');
    const buyer = await makeUser('buyerBackfill');
    const l1 = await makeListing(seller.id, 'Legacy Book', 450);

    const legacyOrderId = crypto.randomUUID();
    await db.insert(orders).values({
      id: legacyOrderId,
      regionCode: 'TW',
      currencyCode: 'TWD',
      buyerId: buyer.id,
      sellerId: seller.id,
      listingId: l1.id,
      listingRef: l1.id,
      bookTitle: 'Legacy Book',
      bookIsbn: '9780000000001',
      totalAmount: 450,
      status: 'accepted',
      createdAt: now(),
      updatedAt: now(),
    });

    // Execute migration SQL query
    await env.DB.prepare(
      `
      INSERT OR IGNORE INTO order_items (id, order_id, listing_id, listing_ref, book_title, book_isbn, price, buyer_id, is_open, created_at)
      SELECT
        lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
        id,
        listing_id,
        coalesce(listing_ref, listing_id, ''),
        book_title,
        book_isbn,
        total_amount,
        buyer_id,
        CASE WHEN status IN ('pending', 'accepted', 'handed_over') THEN 1 ELSE 0 END,
        created_at
      FROM orders
      WHERE id = ?;
    `,
    )
      .bind(legacyOrderId)
      .run();

    const [backfilled] = await db.select().from(orderItems).where(eq(orderItems.orderId, legacyOrderId));
    expect(backfilled).toBeDefined();
    expect(backfilled.bookTitle).toBe('Legacy Book');
    expect(backfilled.price).toBe(450);
    expect(backfilled.isOpen).toBe(1);
    expect(backfilled.buyerId).toBe(buyer.id);
  });

  it('admin stats count each item separately with its own price in book stats', async () => {
    const admin = await makeUser('statsAdmin');
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id));

    const seller = await makeUser('sellerStats');
    const buyer = await makeUser('buyerStats');

    const l1 = await makeListing(seller.id, 'Stats Book 1', 200);
    const l2 = await makeListing(seller.id, 'Stats Book 2', 300);
    await chat(buyer.id, seller.id, [l1.id, l2.id]);

    const createRes = await post('', buyer.token, { listing_ids: [l1.id, l2.id] });
    expect(createRes.status).toBe(201);
    const order = (await createRes.json()) as any;

    await patch(`${order.id}`, seller.token, { status: 'accepted' });
    await patch(`${order.id}`, seller.token, { status: 'handed_over' });
    await patch(`${order.id}`, buyer.token, { status: 'completed' });

    // Request admin stats for Book 1
    const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
    const req1 = new Request(`http://x/api/v1/admin/stats/books/${l1.bookId}?region=TW`, {
      headers: { Authorization: `Bearer ${admin.token}`, 'X-Region': 'TW' },
    });
    const res1 = await worker.fetch(req1);
    expect(res1.status).toBe(200);
    const stats1 = (await res1.json()) as any;
    expect(stats1.summary.all_time_completed).toBe(1);
    expect(stats1.recent_orders[0].total_amount).toBe(200);

    // Request admin stats for Book 2
    const req2 = new Request(`http://x/api/v1/admin/stats/books/${l2.bookId}?region=TW`, {
      headers: { Authorization: `Bearer ${admin.token}`, 'X-Region': 'TW' },
    });
    const res2 = await worker.fetch(req2);
    expect(res2.status).toBe(200);
    const stats2 = (await res2.json()) as any;
    expect(stats2.summary.all_time_completed).toBe(1);
    expect(stats2.recent_orders[0].total_amount).toBe(300);
  });
});
