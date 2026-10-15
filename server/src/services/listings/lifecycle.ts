/**
 * Listing deletion and page bounds.
 */
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { Env } from '../../env';
import { books, conversations, createDb, listings, orders, subscriptions } from '../../db';
import { parsePhotos } from '../../lib/json';
import { deleteListingPhotos } from './photos';

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
  await deleteListingPhotos(env, origin, listing.sellerId, parsePhotos(listing.photos));
}
