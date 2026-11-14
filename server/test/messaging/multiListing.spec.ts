import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, seedListing, seedRegion, seedUser } from './helpers';
import { createDb, conversations, conversationListings, orders, listings } from '../../src/db';
import { eq } from 'drizzle-orm';
import { deleteListing } from '../../src/services/listings/lifecycle';

describe('multi-listing conversations', () => {
  beforeAll(async () => {
    await seedRegion();
  });

  it('reuses most recently active conversation for the same seller and attaches listing', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing1 = await seedListing(seller.id);
    const listing2 = await seedListing(seller.id);

    // First listing opens a new chat (201)
    const firstRes = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing1 }),
    });
    expect(firstRes.status).toBe(201);
    const firstConv = (await firstRes.json()) as any;
    expect(firstConv.listings).toHaveLength(1);
    expect(firstConv.listings[0].ref).toBe(listing1);

    // Second listing from the SAME seller reuses the conversation (200) and attaches listing2
    const secondRes = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing2 }),
    });
    expect(secondRes.status).toBe(200);
    const secondConv = (await secondRes.json()) as any;
    expect(secondConv.id).toBe(firstConv.id);
    expect(secondConv.listings).toHaveLength(2);
    const refs = secondConv.listings.map((l: any) => l.ref);
    expect(refs).toContain(listing1);
    expect(refs).toContain(listing2);

    // Verify system message was posted
    expect(secondConv.latest_message).toContain('[SYSTEM:msg.buyerInquiredBook]');
  });

  it('reopens the chat about a listing after it sold, and after the buyer hid it', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing = await seedListing(seller.id);
    const open = () =>
      api('/api/v1/messaging/conversations', { method: 'POST', token: buyer.token, body: JSON.stringify({ listing_id: listing }) });

    const first = (await (await open()).json()) as any;
    const db = createDb(env.DB);

    // Sold: a chat that already covers the listing still opens (a new one would be refused).
    await db.update(listings).set({ status: 'sold' }).where(eq(listings.id, listing));
    const afterSold = await open();
    expect(afterSold.status).toBe(200);
    expect(((await afterSold.json()) as any).id).toBe(first.id);

    // Hidden by the buyer: the same chat comes back instead of a 409 from the unique index.
    await db.update(conversations).set({ buyerDeletedAt: new Date().toISOString() }).where(eq(conversations.id, first.id));
    const afterHidden = await open();
    expect(afterHidden.status).toBe(200);
    expect(((await afterHidden.json()) as any).id).toBe(first.id);

    // A sold listing with no chat yet is still refused.
    const other = await seedUser({ verifiedIn: 'TW' });
    const fresh = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: other.token,
      body: JSON.stringify({ listing_id: listing }),
    });
    expect(fresh.status).toBe(409);
  });

  it('provides candidate listings endpoint for the buyer only', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const stranger = await seedUser({ verifiedIn: 'TW' });
    const listing1 = await seedListing(seller.id);
    const listing2 = await seedListing(seller.id);
    const listing3 = await seedListing(seller.id);

    const convRes = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing1 }),
    });
    const conv = (await convRes.json()) as any;

    // Buyer fetches candidate listings
    const candRes = await api(`/api/v1/messaging/conversations/${conv.id}/candidate-listings`, {
      method: 'GET',
      token: buyer.token,
    });
    expect(candRes.status).toBe(200);
    const cands = (await candRes.json()) as any;
    expect(cands.count).toBe(2);
    const candIds = cands.results.map((r: any) => r.id);
    expect(candIds).toContain(listing2);
    expect(candIds).toContain(listing3);
    expect(candIds).not.toContain(listing1);

    // Seller gets 403
    const sellerCandRes = await api(`/api/v1/messaging/conversations/${conv.id}/candidate-listings`, {
      method: 'GET',
      token: seller.token,
    });
    expect(sellerCandRes.status).toBe(403);

    // Stranger gets 403
    const strangerCandRes = await api(`/api/v1/messaging/conversations/${conv.id}/candidate-listings`, {
      method: 'GET',
      token: stranger.token,
    });
    expect(strangerCandRes.status).toBe(403);
  });

  it('allows buyer to attach candidate listing via POST /conversations/:id/listings', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing1 = await seedListing(seller.id);
    const listing2 = await seedListing(seller.id);

    const convRes = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing1 }),
    });
    const conv = (await convRes.json()) as any;

    // Attach listing2
    const attachRes = await api(`/api/v1/messaging/conversations/${conv.id}/listings`, {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing2 }),
    });
    expect(attachRes.status).toBe(200);
    const updated = (await attachRes.json()) as any;
    expect(updated.listings).toHaveLength(2);

    // Seller cannot attach
    const sellerAttachRes = await api(`/api/v1/messaging/conversations/${conv.id}/listings`, {
      method: 'POST',
      token: seller.token,
      body: JSON.stringify({ listing_id: listing2 }),
    });
    expect(sellerAttachRes.status).toBe(403);
  });

  it('handles listing removal: buyer only, not last one, not one with open order', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing1 = await seedListing(seller.id);
    const listing2 = await seedListing(seller.id);

    const convRes = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing1 }),
    });
    const conv = (await convRes.json()) as any;

    await api(`/api/v1/messaging/conversations/${conv.id}/listings`, {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing2 }),
    });

    // Seller cannot remove
    const sellerDel = await api(`/api/v1/messaging/conversations/${conv.id}/listings/${listing2}`, {
      method: 'DELETE',
      token: seller.token,
    });
    expect(sellerDel.status).toBe(403);

    // Add an open order on listing2 to test order guard
    const db = createDb(env.DB);
    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(orders).values({
      id: orderId,
      buyerId: buyer.id,
      sellerId: seller.id,
      regionCode: 'TW',
      listingId: listing2,
      listingRef: listing2,
      bookTitle: 'Calculus',
      bookIsbn: '',
      status: 'pending',
      currencyCode: 'TWD',
      totalAmount: 100,
      createdAt: now,
      updatedAt: now,
    });

    // Attempting to remove listing2 fails with 409
    const orderBlocked = await api(`/api/v1/messaging/conversations/${conv.id}/listings/${listing2}`, {
      method: 'DELETE',
      token: buyer.token,
    });
    expect(orderBlocked.status).toBe(409);

    // Can remove listing1 (no open order)
    const del1 = await api(`/api/v1/messaging/conversations/${conv.id}/listings/${listing1}`, {
      method: 'DELETE',
      token: buyer.token,
    });
    expect(del1.status).toBe(200);

    // Now only listing2 remains in conversation: removing it fails with 400 (cannot remove last one)
    const lastBlocked = await api(`/api/v1/messaging/conversations/${conv.id}/listings/${listing2}`, {
      method: 'DELETE',
      token: buyer.token,
    });
    expect(lastBlocked.status).toBe(400);
  });

  it('correctly updates conversation_listings on listing deletion', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing1 = await seedListing(seller.id);
    const listing2 = await seedListing(seller.id);

    const convRes = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing1 }),
    });
    const conv = (await convRes.json()) as any;

    await api(`/api/v1/messaging/conversations/${conv.id}/listings`, {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing2 }),
    });

    const db = createDb(env.DB);
    const [row] = await db.select().from(listings).where(eq(listings.id, listing1)).limit(1);

    // Delete listing1
    await deleteListing(env, 'https://example.com', {
      id: listing1,
      bookId: row.bookId,
      sellerId: seller.id,
      photos: row.photos,
    });

    // Check conversation_listings: listing1 has listingId = null, listingRef preserved
    const [cl1] = await db.select().from(conversationListings).where(eq(conversationListings.listingRef, listing1));
    expect(cl1.listingId).toBeNull();
    expect(cl1.listingRef).toBe(listing1);

    // Listing2 still active
    const [cl2] = await db.select().from(conversationListings).where(eq(conversationListings.listingRef, listing2));
    expect(cl2.listingId).toBe(listing2);

    // Conversation is NOT marked deleted because listing2 is still active
    const getRes = await api('/api/v1/messaging/conversations', {
      method: 'GET',
      token: buyer.token,
    });
    const list = (await getRes.json()) as any;
    expect(list.results[0].listing_deleted).toBe(false);
  });

  it('loads legacy conversations gracefully with listings populated', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing = await seedListing(seller.id);

    // Seed legacy conversation row with NO conversation_listings rows
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = createDb(env.DB);
    await db.insert(conversations).values({
      id,
      roomId: id,
      regionCode: 'TW',
      buyerId: buyer.id,
      sellerId: seller.id,
      listingId: listing,
      listingRef: listing,
      bookTitle: 'Legacy Book',
      bookIsbn: '9780000000000',
      latestMessageBody: 'Hello legacy',
      lastMessageAt: now,
      updatedAt: now,
      createdAt: now,
    });

    const res = await api('/api/v1/messaging/conversations', {
      method: 'GET',
      token: buyer.token,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const legacyConv = data.results.find((c: any) => c.id === id);
    expect(legacyConv).toBeDefined();
    expect(legacyConv.listings).toHaveLength(1);
    expect(legacyConv.listings[0].ref).toBe(listing);
    expect(legacyConv.listings[0].title).toBe('Legacy Book');
  });

  it('backfills conversation_listings from conversations', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing = await seedListing(seller.id);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = createDb(env.DB);
    await db.insert(conversations).values({
      id,
      roomId: id,
      regionCode: 'TW',
      buyerId: buyer.id,
      sellerId: seller.id,
      listingId: listing,
      listingRef: listing,
      bookTitle: 'Calculus Backfill',
      bookIsbn: '9781234567890',
      latestMessageBody: null,
      lastMessageAt: null,
      updatedAt: now,
      createdAt: now,
    });

    // Execute backfill SQL as in migration
    await env.DB.prepare(
      `
      INSERT OR IGNORE INTO conversation_listings (conversation_id, listing_id, listing_ref, book_title, book_isbn, added_at, added_by_id)
      SELECT id, listing_id, COALESCE(listing_ref, listing_id, id), book_title, book_isbn, created_at, buyer_id
      FROM conversations
      WHERE id = ?;
    `,
    )
      .bind(id)
      .run();

    const [cl] = await db.select().from(conversationListings).where(eq(conversationListings.conversationId, id));
    expect(cl).toBeDefined();
    expect(cl.listingId).toBe(listing);
    expect(cl.listingRef).toBe(listing);
    expect(cl.bookTitle).toBe('Calculus Backfill');
    expect(cl.addedById).toBe(buyer.id);
  });

  it('handles race conditions on concurrent conversation opens without 500', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing = await seedListing(seller.id);

    const [res1, res2] = await Promise.all([
      api('/api/v1/messaging/conversations', {
        method: 'POST',
        token: buyer.token,
        body: JSON.stringify({ listing_id: listing }),
      }),
      api('/api/v1/messaging/conversations', {
        method: 'POST',
        token: buyer.token,
        body: JSON.stringify({ listing_id: listing }),
      }),
    ]);

    expect([200, 201]).toContain(res1.status);
    expect([200, 201]).toContain(res2.status);
    const conv1 = (await res1.json()) as any;
    const conv2 = (await res2.json()) as any;
    expect(conv1.id).toBe(conv2.id);
  });
});
