/**
 * Listing deletion and page bounds.
 */
import { and, eq, inArray, ne, notExists, sql } from 'drizzle-orm';
import type { Env } from '../../env';
import { books, conversations, createDb, listings, orders, subscriptions } from '../../db';
import { parsePhotos } from '../../lib/json';
import { deleteListingPhotos } from './photos';
import { chatRoomStub } from '../../lib/chat';

/** Order statuses that still need their listing. */
export const ACTIVE_ORDER_STATUSES = ['pending', 'accepted', 'handed_over'] as const;

export async function hasActiveOrders(env: Env, listingId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.listingId, listingId), inArray(orders.status, ACTIVE_ORDER_STATUSES)))
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
  const rooms = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.listingId, listing.id));
  const [orphanBook] = await db
    .select({ coverR2Key: books.coverR2Key })
    .from(books)
    .where(
      and(
        eq(books.id, listing.bookId),
        notExists(
          db
            .select({ id: listings.id })
            .from(listings)
            .where(and(eq(listings.bookId, listing.bookId), ne(listings.id, listing.id))),
        ),
        notExists(db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.bookId, listing.bookId))),
      ),
    )
    .limit(1);
  await db.batch([
    db
      .update(orders)
      .set({ listingRef: sql`COALESCE(${orders.listingRef}, ${listing.id})`, listingId: null })
      .where(eq(orders.listingId, listing.id)),
    db
      .update(conversations)
      .set({ listingRef: sql`COALESCE(${conversations.listingRef}, ${listing.id})`, listingId: null })
      .where(eq(conversations.listingId, listing.id)),
    db.delete(listings).where(eq(listings.id, listing.id)),
    db
      .delete(books)
      .where(
        and(
          eq(books.id, listing.bookId),
          notExists(db.select({ id: listings.id }).from(listings).where(eq(listings.bookId, listing.bookId))),
          notExists(db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.bookId, listing.bookId))),
        ),
      ),
  ]);
  if (orphanBook?.coverR2Key && orphanBook.coverR2Key.startsWith('covers/')) {
    await env.R2.delete(orphanBook.coverR2Key).catch((e: unknown) =>
      console.error(`[listings] failed to delete ${orphanBook.coverR2Key}`, e),
    );
  }
  // Chats about it are read-only now; sockets already open learn it here.
  await Promise.allSettled(
    rooms.map((r) =>
      chatRoomStub(env, r.id)
        .makeReadOnly()
        .catch((e: unknown) => console.error(`[listings] could not make room ${r.id} read-only`, e)),
    ),
  );
  await deleteListingPhotos(env, origin, listing.sellerId, parsePhotos(listing.photos));
}
