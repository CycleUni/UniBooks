import { and, asc, eq, gte, isNull, lt, lte, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Env } from '../env';
import { createDb, subscriptions, books, users, orders, regions, listings, emailSent } from '../db';
import type { EmailMessage, PushMessage } from '../queues/types';
import { orderLock } from '../services/orders/lock';
import { AUTO_COMPLETE_AFTER_MS, lockKeyFor } from '../services/orders/transitions';
import { deliverNotices } from '../services/orders/notify';
import { purgeTokenStore } from '../services/accounts/tokens';
import { purgeOneTimeTokens } from '../services/accounts/oneTimeTokens';

/**
 * Scheduled jobs. They run only from the Worker's own cron triggers
 * (wrangler.jsonc `triggers.crons`), so there is no HTTP surface and no
 * secret to leak.
 *
 * Mail and push go through EMAIL_QUEUE / PUSH_QUEUE; "sent" below means
 * "accepted by the queue", which is what a row is marked on. A failed enqueue leaves the row unmarked, so
 * the next run retries it.
 */

/** Recipients per run. */
export const MAX_NOTIFY_USERS_PER_RUN = 50;
export const MAX_REMIND_ORDERS_PER_RUN = 50;
/** Lookahead with 5 minutes of overlap for scheduler drift. */
export const MEETUP_REMINDER_LOOKAHEAD_MS = 65 * 60 * 1000;
/** Run-lock timeout: longer than any run; only matters for a run killed mid-way. */
const CRON_RUN_LOCK_TTL_MS = 15 * 60 * 1000;

export type Skipped = { status: 'skipped'; reason: 'already_running' };

/**
 * Run `fn` unless another run of `name` is still going.
 * Both senders mark a row only after it is queued, so two overlapping runs
 * would otherwise read the same unmarked rows and both send.
 */
async function runAlone<T>(env: Env, name: string, fn: () => Promise<T>): Promise<T | Skipped> {
  const lock = orderLock(env, `cron:${name}`);
  if (!(await lock.tryAcquire(CRON_RUN_LOCK_TTL_MS))) return { status: 'skipped', reason: 'already_running' };
  try {
    return await fn();
  } finally {
    await lock.release().catch((e: unknown) => console.error(`[cron:${name}] lock release failed`, e));
  }
}

// ---------------------------------------------------------------------------
// Waitlist ('0 */6 * * *')
// ---------------------------------------------------------------------------

export async function runWaitlistNotify(env: Env) {
  const db = createDb(env.DB);
  const now = new Date().toISOString();

  // Due: the book has an active listing created after the subscription
  // started and after the last time it was notified (or never). One EXISTS
  // probe per subscription, on listings (book_id, status, created_at).
  const dueWhere = and(
    sql`EXISTS (SELECT 1 FROM listings l WHERE l.book_id = ${subscriptions.bookId} AND l.status = 'active'
      AND l.created_at > MAX(${subscriptions.createdAt}, COALESCE(${subscriptions.notifiedAt}, ${subscriptions.createdAt})))`,
    // Nobody to mail: left due, they would hold batch slots forever.
    eq(users.isActive, 1),
    eq(users.isBanned, 0),
    isNull(users.deletedAt),
    sql`${users.email} <> ''`,
  );

  // The users to mail this run, longest-waiting first; one more than the
  // batch, only to tell whether anyone is left for the next run. Only their
  // subscriptions are read, so a run's cost does not grow with the backlog.
  const userRows = await db
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .where(dueWhere)
    .groupBy(subscriptions.userId)
    .orderBy(sql`MIN(${subscriptions.createdAt})`)
    .limit(MAX_NOTIFY_USERS_PER_RUN + 1);
  const userIds = userRows.slice(0, MAX_NOTIFY_USERS_PER_RUN).map((r) => r.userId);
  const moreRemain = userRows.length > MAX_NOTIFY_USERS_PER_RUN;

  const due = userIds.length
    ? await db
        .select({
          id: subscriptions.id,
          userId: subscriptions.userId,
          regionCode: subscriptions.regionCode,
          email: users.email,
          title: books.title,
          isbn13: books.isbn13,
        })
        .from(subscriptions)
        .innerJoin(books, eq(books.id, subscriptions.bookId))
        .innerJoin(users, eq(users.id, subscriptions.userId))
        .where(and(dueWhere, sql`${subscriptions.userId} IN (SELECT value FROM json_each(${JSON.stringify(userIds)}))`))
        .orderBy(asc(subscriptions.createdAt))
    : [];

  // One email per user, however many of their books are due.
  const byUser = new Map<string, typeof due>();
  for (const s of due) {
    const list = byUser.get(s.userId);
    if (list) list.push(s);
    else byUser.set(s.userId, [s]);
  }
  const batch = [...byUser.values()];

  let notifiedUsers = 0;
  let notifiedSubscriptions = 0;
  for (const subs of batch) {
    const first = subs[0];
    const email: EmailMessage = {
      type: 'waitlist_notification',
      user_id: first.userId,
      email: first.email,
      book_title: first.title,
      listing_count: subs.length,
      region: first.regionCode,
      books: subs.map((s) => ({ title: s.title, isbn13: s.isbn13, region: s.regionCode })),
    };
    try {
      await env.EMAIL_QUEUE.send(email);
    } catch (e) {
      console.error(`[WaitlistNotify] enqueue failed for user ${first.userId}`, e);
      continue;
    }
    // Best effort, after the email that decides whether this user is retried.
    try {
      const push: PushMessage = {
        type: 'waitlist_match',
        user_id: first.userId,
        book_title: first.title,
        listing_count: subs.length,
        book_isbn: first.isbn13,
        region: first.regionCode,
      };
      await env.PUSH_QUEUE.send(push);
    } catch (e) {
      console.error(`[WaitlistNotify] push enqueue failed for user ${first.userId}`, e);
    }
    // One bound JSON array, not one parameter per id: D1 caps a statement at
    // 100 bound parameters, and a failure here must not abort the whole run.
    try {
      await db
        .update(subscriptions)
        .set({ notifiedAt: now })
        .where(sql`${subscriptions.id} IN (SELECT value FROM json_each(${JSON.stringify(subs.map((s) => s.id))}))`);
    } catch (e) {
      console.error(`[WaitlistNotify] could not mark user ${first.userId} notified`, e);
      continue;
    }
    notifiedUsers++;
    notifiedSubscriptions += subs.length;
  }

  const result = { notified_users: notifiedUsers, notified_subscriptions: notifiedSubscriptions, more_remain: moreRemain };
  console.log('[WaitlistNotify]', JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Meetup reminders ('*/30 * * * *')
// ---------------------------------------------------------------------------

const buyerU = alias(users, 'cron_buyer');
const sellerU = alias(users, 'cron_seller');

export async function runMeetupReminder(env: Env) {
  const db = createDb(env.DB);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const windowEnd = new Date(nowMs + MEETUP_REMINDER_LOOKAHEAD_MS).toISOString();

  const dueWhere = and(
    eq(orders.status, 'accepted'),
    sql`${orders.meetupTime} IS NOT NULL`,
    gte(orders.meetupTime, now),
    lte(orders.meetupTime, windowEnd),
    isNull(orders.meetupReminderSentAt),
  );
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        order: orders,
        timezone: regions.timezone,
        buyer: { id: buyerU.id, email: buyerU.email, isActive: buyerU.isActive, isBanned: buyerU.isBanned, deletedAt: buyerU.deletedAt },
        seller: {
          id: sellerU.id,
          email: sellerU.email,
          isActive: sellerU.isActive,
          isBanned: sellerU.isBanned,
          deletedAt: sellerU.deletedAt,
        },
      })
      .from(orders)
      .innerJoin(regions, eq(regions.code, orders.regionCode))
      .innerJoin(buyerU, eq(buyerU.id, orders.buyerId))
      .innerJoin(sellerU, eq(sellerU.id, orders.sellerId))
      .where(dueWhere)
      .orderBy(asc(orders.meetupTime))
      .limit(MAX_REMIND_ORDERS_PER_RUN),
    db
      .select({ n: sql<number>`count(*)` })
      .from(orders)
      .where(dueWhere),
  ]);

  let remindedOrders = 0;
  let notifiedUsers = 0;
  for (const { order, timezone, buyer, seller } of rows) {
    const meetupTime = order.meetupTime!;
    const updates: Partial<typeof orders.$inferInsert> = {};
    const sentTo = new Set<string>();

    const parties = [
      { user: buyer, field: 'buyerReminderSentAt' as const, done: order.buyerReminderSentAt },
      { user: seller, field: 'sellerReminderSentAt' as const, done: order.sellerReminderSentAt },
    ];
    for (const { user, field, done } of parties) {
      if (done !== null) continue;
      // Inactive/banned/deleted accounts or accounts with no email are skipped (and marked).
      if (!user.isActive || user.isBanned || user.deletedAt !== null || !user.email) {
        updates[field] = now;
        continue;
      }
      // buyer == seller: one email, both fields marked.
      if (sentTo.has(user.id)) {
        updates[field] = now;
        continue;
      }
      const email: EmailMessage = {
        type: 'meetup_reminder',
        user_id: user.id,
        email: user.email,
        order_id: order.id,
        book_title: order.bookTitle,
        meetup_time: meetupTime,
        meetup_location: order.meetupLocation,
        region: order.regionCode,
        timezone: timezone ?? undefined,
      };
      try {
        await env.EMAIL_QUEUE.send(email);
      } catch (e) {
        console.error(`[MeetupReminder] enqueue failed for order ${order.id} user ${user.id}`, e);
        continue;
      }
      updates[field] = now;
      sentTo.add(user.id);
      notifiedUsers++;
      // Best effort. No location: a lock screen should not say where two people are meeting.
      try {
        const push: PushMessage = {
          type: 'meetup_reminder',
          user_id: user.id,
          order_id: order.id,
          book_title: order.bookTitle,
          meetup_time: meetupTime,
        };
        await env.PUSH_QUEUE.send(push);
      } catch (e) {
        console.error(`[MeetupReminder] push enqueue failed for order ${order.id}`, e);
      }
    }

    const buyerDone = updates.buyerReminderSentAt != null || order.buyerReminderSentAt !== null;
    const sellerDone = updates.sellerReminderSentAt != null || order.sellerReminderSentAt !== null;
    if (buyerDone && sellerDone) {
      updates.meetupReminderSentAt = now;
      remindedOrders++;
    }
    if (Object.keys(updates).length) {
      // Only while the meetup is still the one reminded about: a reschedule
      // under way clears these fields and must not be overwritten.
      await db
        .update(orders)
        .set(updates)
        .where(and(eq(orders.id, order.id), eq(orders.meetupTime, meetupTime), isNull(orders.meetupReminderSentAt)));
    }
  }

  const result = { reminded_orders: remindedOrders, notified_users: notifiedUsers, remaining_orders: Math.max(0, Number(n) - rows.length) };
  console.log('[MeetupReminder]', JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Auto-complete ('*/30 * * * *')
// ---------------------------------------------------------------------------

export const MAX_AUTO_COMPLETE_ORDERS_PER_RUN = 50;

/**
 * Complete `handed_over` orders the buyer never confirmed, 7 days after the
 * agreed meetup (or after the handover mark, if that came later). The exact
 * deadline is re-checked under the order lock.
 */
export async function runAutoComplete(env: Env) {
  const db = createDb(env.DB);
  // Due when both the handover and the meetup lie past the window (the same
  // rule as autoCompleteDueAt, which the lock re-checks): no row that is not
  // yet due can fill the batch and hold back one that is.
  const cutoff = new Date(Date.now() - AUTO_COMPLETE_AFTER_MS).toISOString();
  const handedOver = sql`COALESCE(${orders.handedOverAt}, ${orders.updatedAt})`;
  const rows = await db
    .select({ id: orders.id, listingId: orders.listingId })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'handed_over'),
        sql`${handedOver} <= ${cutoff}`,
        sql`(${orders.meetupTime} IS NULL OR ${orders.meetupTime} <= ${cutoff})`,
      ),
    )
    .orderBy(asc(handedOver))
    .limit(MAX_AUTO_COMPLETE_ORDERS_PER_RUN);

  let completed = 0;
  for (const o of rows) {
    try {
      const res = await orderLock(env, lockKeyFor(o)).autoComplete({ orderId: o.id });
      if (!res.ok) continue;
      completed++;
      await deliverNotices(env, res.order, res.notices);
    } catch (e) {
      console.error(`[AutoComplete] failed for order ${o.id}`, e);
    }
  }
  const result = { completed_orders: completed, scanned_orders: rows.length };
  console.log('[AutoComplete]', JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Cleanup ('0 3 * * *')
// ---------------------------------------------------------------------------

export async function runCleanup(env: Env) {
  const [{ total }] = await createDb(env.DB)
    .select({ total: sql<number>`count(*)` })
    .from(books);
  // Books with no listings (any status) and no subscriptions.
  const db = createDb(env.DB);
  const orphans = await db
    .delete(books)
    .where(
      and(
        notExists(db.select({ id: listings.id }).from(listings).where(eq(listings.bookId, books.id))),
        notExists(db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.bookId, books.id))),
      ),
    )
    .run();
  const tokensPurged = await purgeTokenStore(env);
  const linksPurged = await purgeOneTimeTokens(env);
  // Redelivery only happens within the queue's retry window, so a day is plenty.
  const sentPurged = await db
    .delete(emailSent)
    .where(lt(emailSent.sentAt, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()))
    .run();
  // Throttle counters live in the RateLimiter Durable Object and expire on
  // their own, so there is nothing to purge here.
  const result = {
    orphan_books_deleted: orphans.meta.changes ?? 0,
    scanned_books: Number(total),
    refresh_tokens_purged: tokensPurged,
    one_time_tokens_purged: linksPurged,
    email_sent_purged: sentPurged.meta.changes ?? 0,
  };
  console.log('[Cleanup]', JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleScheduled(controller: Pick<ScheduledController, 'cron'>, env: Env): Promise<void> {
  try {
    switch (controller.cron) {
      case '0 */6 * * *':
        await runAlone(env, 'WaitlistNotify', () => runWaitlistNotify(env));
        break;
      case '*/30 * * * *':
        await runAlone(env, 'MeetupReminder', () => runMeetupReminder(env));
        await runAlone(env, 'AutoComplete', () => runAutoComplete(env));
        break;
      case '0 3 * * *':
        await runCleanup(env);
        break;
      default:
        console.warn(`[cron] unhandled trigger ${controller.cron}`);
    }
  } catch (e) {
    console.error(`[cron] ${controller.cron} failed`, e);
    throw e;
  }
}
