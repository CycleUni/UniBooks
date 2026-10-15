import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '../../env';
import { createDb, orders, listings, regions, auditEvents } from '../../db';
import { parseMeetupTime } from './time';
import type { NoticeOrder, OrderNotice } from './notify';

/**
 * Order state changes. Each runs inside the listing's OrderLock (see
 * durable-objects/OrderLock.ts and ./lock.ts), a row lock on
 * the listing and the order: the check is made
 * against a fresh read taken under the lock, and the writes go out as one D1
 * batch (a transaction) whose UPDATEs are themselves conditional on the
 * status they expect, so a write that slips past the lock still cannot
 * apply to a row that moved on.
 *
 * Results are plain data: they cross the Durable Object RPC boundary.
 */

export const ACTIVE_ORDER_STATUSES = ['pending', 'accepted', 'handed_over'] as const;
export const FINAL_ORDER_STATUSES = ['cancelled', 'completed'] as const;
export const ORDER_STATUSES = ['pending', 'accepted', 'handed_over', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed status moves. */
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['accepted', 'cancelled'],
  accepted: ['handed_over', 'cancelled'],
  handed_over: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** Who may trigger each legal edge. */
const TRANSITION_ACTOR: Record<string, 'buyer' | 'seller' | 'either'> = {
  'pending>accepted': 'seller',
  'pending>cancelled': 'either',
  'accepted>handed_over': 'seller',
  'accepted>cancelled': 'either',
  'handed_over>completed': 'buyer',
  // The buyer has the book by now; letting them cancel would put it back on
  // sale. The seller (a handover marked by mistake) or an admin still can.
  'handed_over>cancelled': 'seller',
};

/** The system notice for each move, keyed by old>new>actor role. */
const TRANSITION_NOTICE: Record<string, string> = {
  'pending>accepted>seller': 'order.notify.seller_approved',
  'pending>cancelled>buyer': 'order.notify.cancelled_by_buyer',
  'pending>cancelled>seller': 'order.notify.seller_rejected',
  'accepted>cancelled>buyer': 'order.notify.cancelled_by_buyer',
  'accepted>cancelled>seller': 'order.notify.cancelled_by_seller',
  'accepted>handed_over>seller': 'order.notify.delivered',
  'handed_over>completed>buyer': 'order.notify.delivered',
  'handed_over>cancelled>seller': 'order.notify.cancelled_by_seller',
};

/** The reasons a buyer or seller may give for a cancel; `admin_override: …` is the platform's alone. */
const PARTICIPANT_CANCEL_REASONS = new Set(['buyer_cancelled', 'seller_cancelled', 'seller_rejected', 'seller_declined']);

/** Statuses in which the seller may still change the agreed time/place. */
const MEETUP_EDITABLE_STATUSES: string[] = ['accepted'];

/** A refusal carries the API error contract's code (and per-field codes); the route turns it into the response. */
export type LockedResult =
  | { ok: true; order: NoticeOrder; notices: OrderNotice[] }
  | { ok: false; status: 400 | 403 | 404; code: string; fields?: Record<string, string[]> };

const codeError = (status: 400 | 403 | 404, code: string): LockedResult => ({ ok: false, status, code });
const fieldError = (fields: Record<string, string[]>): LockedResult => ({ ok: false, status: 400, code: 'common.errValidation', fields });

function toNotice(o: typeof orders.$inferSelect): NoticeOrder {
  return {
    id: o.id,
    buyerId: o.buyerId,
    sellerId: o.sellerId,
    listingId: o.listingId,
    listingRef: o.listingRef,
    bookTitle: o.bookTitle,
    status: o.status,
  };
}

/** Lock key for an order: its listing while it has one. */
export function lockKeyFor(order: { id: string; listingId: string | null }): string {
  return order.listingId ? `listing:${order.listingId}` : `order:${order.id}`;
}

/**
 * PATCH /api/v1/orders/<id>/ under the lock. The caller has already
 * checked that `actorId` may see the order and is verified in its region.
 */
/** A no-show is reportable only for a meetup arranged at least this far ahead. */
export const NO_SHOW_MIN_NOTICE_MS = 60 * 60 * 1000;

export async function applyOrderUpdate(
  env: Env,
  args: { orderId: string; actorId: string; data: Record<string, unknown> },
): Promise<LockedResult> {
  const db = createDb(env.DB);
  const { orderId, actorId, data } = args;
  const [row] = await db
    .select({ order: orders, timezone: regions.timezone })
    .from(orders)
    .innerJoin(regions, eq(regions.code, orders.regionCode))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) return codeError(404, 'common.errNotFound');
  const order = row.order;
  if (actorId !== order.buyerId && actorId !== order.sellerId) return codeError(404, 'common.errNotFound');
  const isSeller = actorId === order.sellerId;
  const isBuyer = actorId === order.buyerId;
  const oldStatus = order.status as OrderStatus;

  // Who may make this move — checked before the payload.
  const requested = data.status;
  if (requested) {
    const role = TRANSITION_ACTOR[`${oldStatus}>${String(requested)}`];
    if (role === 'seller' && !isSeller) return codeError(403, 'order.errSellerOnly');
    if (role === 'buyer' && !isBuyer) return codeError(403, 'order.errBuyerOnly');
    if (role === 'either' && !isSeller && !isBuyer) return codeError(403, 'order.errNotParticipant');
  }
  if ('meetup_time' in data || 'meetup_location' in data) {
    // The meetup is the seller's to set, with a move (accepting) or on its
    // own while accepted.
    if (!isSeller) return codeError(403, 'order.errSellerOnly');
    if (!requested && !MEETUP_EDITABLE_STATUSES.includes(oldStatus)) return codeError(400, 'order.errMeetupNotEditable');
  }

  // Partial update: status, cancel_reason, meetup_time, meetup_location.
  const errors: Record<string, string[]> = {};
  const set: Partial<typeof orders.$inferInsert> = {};
  let newStatus: OrderStatus = oldStatus;
  if ('status' in data) {
    const s = data.status;
    if (
      typeof s !== 'string' ||
      !(ORDER_STATUSES as readonly string[]).includes(s) ||
      !VALID_TRANSITIONS[oldStatus].includes(s as OrderStatus)
    ) {
      errors.status = ['order.errInvalidTransition'];
    } else {
      newStatus = s as OrderStatus;
      set.status = newStatus;
    }
  }
  if ('cancel_reason' in data) {
    // Only with the cancel itself, and only a reason a participant can give:
    // a finished order's reason (an admin's override included) is final.
    const r = data.cancel_reason;
    if (data.status !== 'cancelled' || (r !== null && !(typeof r === 'string' && PARTICIPANT_CANCEL_REASONS.has(r)))) {
      errors.cancel_reason = ['common.errValidation'];
    } else {
      set.cancelReason = r;
    }
  }
  let meetupTimeChanged = false;
  if ('meetup_time' in data) {
    const t = parseMeetupTime(data.meetup_time, row.timezone);
    if (t === undefined) errors.meetup_time = ['common.errValidation'];
    // A meetup cannot be arranged in the past (it would make the order
    // instantly no-show-reportable).
    else if (t && t !== order.meetupTime && Date.parse(t) < Date.now()) errors.meetup_time = ['common.errValidation'];
    else {
      set.meetupTime = t;
      meetupTimeChanged = t !== order.meetupTime;
    }
  }
  if ('meetup_location' in data) {
    const l = data.meetup_location;
    if (typeof l === 'string' && l.length <= 255) set.meetupLocation = l;
    else errors.meetup_location = ['common.errValidation'];
  }
  if (Object.keys(errors).length) return fieldError(errors);

  // Of two racing accepts the second finds the listing reserved.
  const accepting = newStatus === 'accepted' && oldStatus !== 'accepted';
  if (accepting) {
    const [listing] = order.listingId
      ? await db.select({ status: listings.status }).from(listings).where(eq(listings.id, order.listingId)).limit(1)
      : [];
    if (!listing || listing.status !== 'active') return codeError(400, 'checkout.errListingUnavailable');
  }

  const now = new Date().toISOString();
  set.updatedAt = now;
  if (meetupTimeChanged) {
    set.meetupSetAt = now;
    set.buyerReminderSentAt = null;
    set.sellerReminderSentAt = null;
    set.meetupReminderSentAt = null;
  }
  if (newStatus === 'completed' && !order.completedAt) set.completedAt = now;
  if (
    newStatus === 'cancelled' &&
    oldStatus === 'accepted' &&
    order.meetupTime &&
    order.meetupTime <= now &&
    // ...and was arranged with real notice: not moved to "a minute from now"
    // just before cancelling, to manufacture a no-show against the other side.
    order.meetupSetAt &&
    Date.parse(order.meetupTime) - Date.parse(order.meetupSetAt) >= NO_SHOW_MIN_NOTICE_MS
  ) {
    // The agreed meetup (as it stood before this request) has come and gone:
    // a no-show report may follow this cancel, and no other.
    set.noShowReportable = 1;
  }

  const orderGuard = [eq(orders.id, order.id), eq(orders.status, oldStatus)];
  if (accepting) {
    orderGuard.push(sql`EXISTS (SELECT 1 FROM ${listings} WHERE ${listings.id} = ${order.listingId} AND ${listings.status} = 'active')`);
  }
  const orderUpdate = db
    .update(orders)
    .set(set)
    .where(and(...orderGuard))
    .returning({ id: orders.id });
  // Each listing write applies only if this very order write did.
  const thisWrite = sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${order.id} AND ${orders.status} = ${newStatus} AND ${orders.updatedAt} = ${now})`;

  let listingUpdate;
  if (order.listingId && newStatus !== oldStatus) {
    if (newStatus === 'cancelled' && (oldStatus === 'accepted' || oldStatus === 'handed_over')) {
      // Release only a reservation this order held, and never un-sell.
      listingUpdate = db
        .update(listings)
        .set({ status: 'active' })
        .where(and(eq(listings.id, order.listingId), eq(listings.status, 'reserved'), thisWrite));
    } else if (newStatus === 'accepted') {
      listingUpdate = db
        .update(listings)
        .set({ status: 'reserved' })
        .where(and(eq(listings.id, order.listingId), eq(listings.status, 'active'), thisWrite));
    } else if (newStatus === 'completed') {
      listingUpdate = db
        .update(listings)
        .set({ status: 'sold' })
        // Only the reservation this order holds becomes a sale: a listing
        // taken down meanwhile stays removed.
        .where(and(eq(listings.id, order.listingId), eq(listings.status, 'reserved'), thisWrite));
    }
  }

  const results = listingUpdate ? await db.batch([orderUpdate, listingUpdate]) : await db.batch([orderUpdate]);
  const updated = results[0] as { id: string }[];
  if (!updated.length) {
    // The order (or its listing) moved on between the read and the write.
    return accepting ? codeError(400, 'checkout.errListingUnavailable') : fieldError({ status: ['order.errInvalidTransition'] });
  }

  const after = { ...order, ...set } as typeof orders.$inferSelect;
  const notices: OrderNotice[] = [];
  if (newStatus !== oldStatus) {
    const key = TRANSITION_NOTICE[`${oldStatus}>${newStatus}>${isSeller ? 'seller' : 'buyer'}`];
    if (key) notices.push({ key, senderId: actorId, push: true });
  } else if (
    (set.meetupTime !== undefined && set.meetupTime !== order.meetupTime) ||
    (set.meetupLocation !== undefined && set.meetupLocation !== order.meetupLocation)
  ) {
    // The seller edited the agreed time/place.
    notices.push({ key: 'order.notify.meetup_updated', senderId: order.sellerId, push: false });
  }
  return { ok: true, order: toNotice(after), notices };
}

/**
 * Cancel an order on the platform's (or the removed listing's) authority.
 * `final: true` when the
 * order was already completed or cancelled by the time the lock was taken.
 */
export async function applyPlatformCancel(
  env: Env,
  args: { orderId: string; actorId: string; cancelReason: string; noticeKey: string; audit?: { reason: string } },
): Promise<{ ok: true; order: NoticeOrder; notices: OrderNotice[] } | { ok: false; final: boolean }> {
  const db = createDb(env.DB);
  const [order] = await db.select().from(orders).where(eq(orders.id, args.orderId)).limit(1);
  if (!order) return { ok: false, final: false };
  if ((FINAL_ORDER_STATUSES as readonly string[]).includes(order.status)) return { ok: false, final: true };
  const oldStatus = order.status;
  const now = new Date().toISOString();

  const stmts = [];
  stmts.push(
    db
      .update(orders)
      .set({ status: 'cancelled', cancelReason: args.cancelReason, updatedAt: now })
      .where(and(eq(orders.id, order.id), eq(orders.status, oldStatus)))
      .returning({ id: orders.id }),
  );
  if (order.listingId && (oldStatus === 'accepted' || oldStatus === 'handed_over')) {
    stmts.push(
      db
        .update(listings)
        .set({ status: 'active' })
        .where(
          and(
            eq(listings.id, order.listingId),
            eq(listings.status, 'reserved'),
            sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${order.id} AND ${orders.status} = 'cancelled' AND ${orders.updatedAt} = ${now})`,
          ),
        ),
    );
  }
  const results = await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
  if (!(results[0] as { id: string }[]).length) return { ok: false, final: true };
  if (args.audit) {
    // Written only once the conditional cancel above is known to have applied.
    await db.insert(auditEvents).values({
      actorId: args.actorId,
      action: 'admin.order_force_cancelled',
      targetType: 'order',
      targetId: order.id,
      details: JSON.stringify({ order_id: order.id, reason: args.audit.reason }),
      createdAt: now,
    });
  }
  return {
    ok: true,
    order: toNotice({ ...order, status: 'cancelled', cancelReason: args.cancelReason, updatedAt: now }),
    notices: [{ key: args.noticeKey, senderId: args.actorId, push: true }],
  };
}
