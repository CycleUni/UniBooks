import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Env } from '../../env';
import { apiError } from '../../lib/http';
import { createDb, orders } from '../../db';
import { ACTIVE_ORDER_STATUSES, lockKeyFor } from './transitions';
import { orderLock } from './lock';
import { deliverNotices } from './notify';

/**
 * Cancel every open order (pending / accepted / handed_over) on a listing,
 * when a listing is removed: status -> cancelled, the
 * listing's reservation released, a system notice posted to each order's
 * conversation once the cancel has committed. Shared by the listings module
 * (seller delete) and the admin module (platform delete).
 *
 * Call it BEFORE deleting the listing (the order keeps its snapshot; its
 * listing_id goes NULL with the delete). Returns how many orders it cancelled.
 *
 * - 'admin_removed': cancel_reason `admin_override: <note>` (the admin delete
 *   requires a written reason; pass it as `note`), an audit event, notice
 *   order.notify.admin_cancelled.
 * - 'listing_removed': cancel_reason `seller_cancelled`, notice
 *   order.notify.cancelled_by_seller. NB a seller's
 *   delete with an open order never gets here: it answers 409 listing.errHasActiveOrders.
 */
export async function cancelOpenOrdersForListing(
  env: Env,
  args: { listingId: string; actorId: string; reason: 'listing_removed' | 'admin_removed'; note?: string },
): Promise<number> {
  const db = createDb(env.DB);
  const open = await db
    .select({ id: orders.id, listingId: orders.listingId })
    .from(orders)
    .where(and(eq(orders.listingId, args.listingId), inArray(orders.status, [...ACTIVE_ORDER_STATUSES])));
  const admin = args.reason === 'admin_removed';
  const note = (args.note ?? '').trim() || 'listing_removed';
  let cancelled = 0;
  for (const o of open) {
    const res = await orderLock(env, lockKeyFor(o)).platformCancel({
      orderId: o.id,
      actorId: args.actorId,
      cancelReason: admin ? `admin_override: ${note}` : 'seller_cancelled',
      noticeKey: admin ? 'order.notify.admin_cancelled' : 'order.notify.cancelled_by_seller',
      audit: admin ? { reason: note } : undefined,
    });
    if (res.ok) {
      cancelled++;
      await deliverNotices(env, res.order, res.notices);
    }
  }
  return cancelled;
}

/**
 * Admin force-cancel of one order (after
 * its own checks: region scope and a reason of at least 3 characters are
 * the admin route's job). Throws a 404 ({detail}) for an unknown order and
 * 400 admin.errOrderAlreadyFinal when it is (or became, under the lock)
 * completed or cancelled. Re-read the order afterwards for the response.
 */
export async function forceCancelOrder(env: Env, args: { orderId: string; actorId: string; reason?: string }): Promise<void> {
  const db = createDb(env.DB);
  const [o] = await db.select({ id: orders.id, listingId: orders.listingId }).from(orders).where(eq(orders.id, args.orderId)).limit(1);
  if (!o) throw new HTTPException(404, { res: Response.json({ detail: 'Not found.' }, { status: 404 }) });
  const reason = (args.reason ?? '').trim();
  const res = await orderLock(env, lockKeyFor(o)).platformCancel({
    orderId: o.id,
    actorId: args.actorId,
    cancelReason: `admin_override: ${reason}`,
    noticeKey: 'order.notify.admin_cancelled',
    audit: { reason },
  });
  if (!res.ok) apiError(400, 'admin.errOrderAlreadyFinal');
  await deliverNotices(env, res.order, res.notices);
}
