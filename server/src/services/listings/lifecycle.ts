/**
 * Listing deletion and page bounds.
 */
import { HTTPException } from 'hono/http-exception';
import type { Env } from '../../env';
import { pagination } from '../../lib/http';
import { parsePhotos } from '../../lib/json';
import { deleteListingPhotos } from './photos';

/** Order statuses that still need their listing. */
export const ACTIVE_ORDER_STATUSES = ['pending', 'accepted', 'handed_over'] as const;

export async function hasActiveOrders(env: Env, listingId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM orders WHERE listing_id = ? AND status IN ('pending','accepted','handed_over') LIMIT 1`,
  )
    .bind(listingId)
    .first();
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
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET listing_ref = COALESCE(listing_ref, ?1), listing_id = NULL WHERE listing_id = ?1`).bind(listing.id),
    env.DB.prepare(`UPDATE conversations SET listing_ref = COALESCE(listing_ref, ?1), listing_id = NULL WHERE listing_id = ?1`).bind(
      listing.id,
    ),
    env.DB.prepare(`DELETE FROM listings WHERE id = ?`).bind(listing.id),
    env.DB.prepare(
      `DELETE FROM books WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM listings WHERE book_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE book_id = ?1)`,
    ).bind(listing.bookId),
  ]);
  await deleteListingPhotos(env, origin, listing.sellerId, parsePhotos(listing.photos));
}

/**
 * Page bounds, answering 404 {"detail":"Invalid page."}
 * for a page past the end (page 1 of nothing is fine).
 */
export function pageFor(url: string, count: number) {
  const p = pagination(url);
  if (p.page > 1 && p.offset >= count) {
    throw new HTTPException(404, {
      res: Response.json({ detail: 'Invalid page.' }, { status: 404 }),
      message: 'Invalid page.',
    });
  }
  return p;
}
