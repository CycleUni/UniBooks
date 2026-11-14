/**
 * Listing deletion and page bounds.
 */
import { and, eq, inArray, notExists, or, sql } from 'drizzle-orm';
import type { Env } from '../../env';
import { books, conversations, conversationListings, createDb, listings, orders, orderItems, subscriptions } from '../../db';
import { parsePhotos } from '../../lib/json';
import { deleteListingPhotos } from './photos';
import { chatRoomStub } from '../../lib/chat';
import { getConversation, isConversationReadOnly } from '../messaging/conversations';

/** Order statuses that still need their listing. */
export const ACTIVE_ORDER_STATUSES = ['pending', 'accepted', 'handed_over'] as const;

export async function hasActiveOrders(env: Env, listingId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        inArray(orders.status, ACTIVE_ORDER_STATUSES),
        or(
          eq(orders.listingId, listingId),
          sql`EXISTS (SELECT 1 FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id} AND ${orderItems.listingId} = ${listingId})`,
        ),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Delete a listing, keeping the history that points at it: orders and
 * conversations lose their FK (set to NULL) but keep `listing_ref`, so
 * the buyer's order history and the chat stay readable. The book goes too
 * when nothing else (listing or subscription) references it. Photos are
 * removed from R2 afterwards, only under the seller's own listing prefix and
 * only when no other listing still shows them.
 */
export async function deleteListing(
  env: Env,
  origin: string,
  listing: { id: string; bookId: string; sellerId: string; photos: string },
): Promise<void> {
  const db = createDb(env.DB);
  const rooms = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      or(
        eq(conversations.listingId, listing.id),
        sql`EXISTS (SELECT 1 FROM ${conversationListings} WHERE ${conversationListings.conversationId} = ${conversations.id} AND ${conversationListings.listingId} = ${listing.id})`,
      ),
    );
  const [, , , , orphans] = await db.batch([
    db
      .update(orders)
      .set({ listingRef: sql`COALESCE(${orders.listingRef}, ${listing.id})`, listingId: null })
      .where(eq(orders.listingId, listing.id)),
    db
      .update(conversations)
      .set({ listingRef: sql`COALESCE(${conversations.listingRef}, ${listing.id})`, listingId: null })
      .where(eq(conversations.listingId, listing.id)),
    db
      .update(conversationListings)
      .set({ listingRef: sql`COALESCE(${conversationListings.listingRef}, ${listing.id})`, listingId: null })
      .where(eq(conversationListings.listingId, listing.id)),
    db.delete(listings).where(eq(listings.id, listing.id)),
    db
      .delete(books)
      .where(
        and(
          eq(books.id, listing.bookId),
          notExists(db.select({ id: listings.id }).from(listings).where(eq(listings.bookId, listing.bookId))),
          notExists(db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.bookId, listing.bookId))),
        ),
      )
      // The cover goes only with a book this batch removed: a listing added
      // for it meanwhile keeps the book, and the book keeps its cover.
      .returning({ coverR2Key: books.coverR2Key }),
  ]);
  for (const { coverR2Key } of orphans) {
    if (coverR2Key?.startsWith('covers/')) {
      await env.R2.delete(coverR2Key).catch((e: unknown) => console.error(`[listings] failed to delete ${coverR2Key}`, e));
    }
  }
  // Chats about it are read-only now if all their listings are gone; sockets already open learn it here.
  for (const r of rooms) {
    const conv = await getConversation(env, r.id);
    if (conv && (await isConversationReadOnly(env, conv))) {
      await chatRoomStub(env, r.id)
        .makeReadOnly()
        .catch((e: unknown) => console.error(`[listings] could not make room ${r.id} read-only`, e));
    }
  }
  await deleteListingPhotos(env, origin, listing.sellerId, parsePhotos(listing.photos));
}
