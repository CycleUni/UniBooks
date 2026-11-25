import { and, asc, eq, gt, gte, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Env } from '../env';
import {
  createDb,
  subscriptions,
  courseWants,
  schools,
  listings,
  books,
  users,
  orders,
  regions,
  regionVerifications,
  emailSent,
  pushSent,
  studentIdVerifications,
  organizationMembers,
} from '../db';
import type { EmailMessage, PushMessage } from '../queues/types';
import { notExpired } from '../lib/requestExpiry';
import { orderLock } from '../services/orders/lock';
import { AUTO_COMPLETE_AFTER_MS, lockKeyFor } from '../services/orders/transitions';
import { deliverNotices } from '../services/orders/notify';
import { purgeTokenStore } from '../services/accounts/tokens';
import { purgeOneTimeTokens, purgePendingRegistrations } from '../services/accounts/oneTimeTokens';
import { runCoverSweep, runCoverCleanup } from '../services/catalog/covers';
import { deleteUnusedBooks } from '../services/catalog/unused';
import { courseKey } from '../lib/course';
import { sweepDeletedConversations } from '../services/messaging/conversations';
import { today } from '../services/orgs/roster';

export { runCoverSweep, runCoverCleanup };

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
  const holder = await lock.tryAcquire(CRON_RUN_LOCK_TTL_MS);
  if (!holder) return { status: 'skipped', reason: 'already_running' };
  try {
    return await fn();
  } finally {
    await lock.release(holder).catch((e: unknown) => console.error(`[cron:${name}] lock release failed`, e));
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a waitlist notice (book or course) says to one user; see sendWaitlistNotice. */
interface WaitlistNotice {
  /** For log lines. */
  job: string;
  userId: string;
  email: string;
  region: string;
  /** Ids of the rows being told about, so the same rows are never sent twice. */
  dedupeIds: string[];
  /** Set when the notice is about a course request rather than a book request. */
  courseName?: string;
  /** The courses behind courseName, with their school codes, for links to the course pages. */
  courses?: { name: string; school: string }[];
  books: { id: string; title: string; isbn13: string | null }[];
}

/**
 * Queue the email and the push for one user's waitlist notice, once. True when the email was
 * accepted by the queue, which is what decides that the user need not be retried; the push is
 * best effort.
 */
async function sendWaitlistNotice(env: Env, n: WaitlistNotice): Promise<boolean> {
  const first = n.books[0];
  // These rows, told about once: a run whose notified_at write failed sends nothing new.
  const dedupeKey = `${n.courseName ? 'course-wait' : 'waitlist'}:${await sha256Hex([...n.dedupeIds].sort().join(','))}`;
  const email: EmailMessage = {
    type: 'waitlist_notification',
    dedupe_key: dedupeKey,
    user_id: n.userId,
    email: n.email,
    book_title: first.title,
    book_id: first.id,
    listing_count: n.books.length,
    region: n.region,
    ...(n.courseName ? { course_name: n.courseName } : {}),
    ...(n.courses ? { courses: n.courses } : {}),
    books: n.books.map((b) => ({ id: b.id, title: b.title, isbn13: b.isbn13, region: n.region })),
  };
  try {
    await env.EMAIL_QUEUE.send(email);
  } catch (e) {
    console.error(`[${n.job}] enqueue failed for user ${n.userId}`, e);
    return false;
  }
  // Best effort, after the email that decides whether this user is retried.
  try {
    const push: PushMessage = {
      type: 'waitlist_match',
      dedupe_key: dedupeKey,
      user_id: n.userId,
      book_title: first.title,
      listing_count: n.books.length,
      book_isbn: first.isbn13,
      region: n.region,
      ...(n.courseName ? { course_name: n.courseName } : {}),
    };
    await env.PUSH_QUEUE.send(push);
  } catch (e) {
    console.error(`[${n.job}] push enqueue failed for user ${n.userId}`, e);
  }
  return true;
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
    notExpired(subscriptions.expiresAt, now),
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
          bookId: books.id,
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
    const sent = await sendWaitlistNotice(env, {
      job: 'WaitlistNotify',
      userId: first.userId,
      email: first.email,
      region: first.regionCode,
      dedupeIds: subs.map((s) => s.id),
      books: subs.map((s) => ({ id: s.bookId, title: s.title, isbn13: s.isbn13 })),
    });
    if (!sent) continue;
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

/** Requests read per run once the courses with something new are known. */
const MAX_COURSE_WANTS_PER_RUN = 5000;
/** New listings read per run when matching them to course requests. */
const MAX_COURSE_LISTINGS_PER_RUN = 5000;

/**
 * "I am taking this course": tell each student who asked when a book for the
 * course is listed at their school. Same cadence, queues and one-notice-per-user
 * shape as the book waitlist; a course matches by lib/course.ts' key, which SQL
 * cannot compute, so the matching happens here.
 *
 * It starts from what is new, not from the requests. Requests are never deleted
 * once told about, so a job that read "the first N requests" would stop seeing
 * the newest ones as soon as N were on file. What is new is bounded by how much
 * was listed since, however many requests there are.
 */
export async function runCourseWaitNotify(env: Env) {
  const db = createDb(env.DB);
  const now = new Date().toISOString();
  const none = { notified_users: 0, notified_course_wants: 0 };

  // 1. The oldest moment any request still waits from: nothing listed before it matters.
  const waiting = await env.DB.prepare(
    `SELECT min(max(created_at, coalesce(notified_at, created_at))) AS oldest FROM course_wants
      WHERE expires_at IS NULL OR expires_at > ?`,
  )
    .bind(now)
    .first<{ oldest: string | null }>();
  if (!waiting?.oldest) return none;

  // 2. The courses (school + spelling) listed since then. Few, whatever the number of listings.
  const { results: spelled } = await env.DB.prepare(
    `SELECT DISTINCT school_id AS schoolId, course_name AS name FROM listings
      WHERE status = 'active' AND course_name <> '' AND school_id IS NOT NULL AND created_at > ?
        AND region_code IN (SELECT DISTINCT region_code FROM course_wants WHERE expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(waiting.oldest, now)
    .all<{ schoolId: number; name: string }>();
  const newPairs = new Map<string, string[]>();
  for (const sp of spelled) {
    const pair = `${sp.schoolId}:${courseKey(sp.name)}`;
    const names = newPairs.get(pair);
    if (names) names.push(sp.name);
    else newPairs.set(pair, [sp.name]);
  }
  if (!newPairs.size) return none;

  // 3. Only the requests for those courses.
  const wants = await db
    .select({
      id: courseWants.id,
      userId: courseWants.userId,
      schoolId: courseWants.schoolId,
      regionCode: courseWants.regionCode,
      key: courseWants.courseKey,
      name: courseWants.courseName,
      schoolCode: schools.code,
      since: sql<string>`MAX(${courseWants.createdAt}, COALESCE(${courseWants.notifiedAt}, ${courseWants.createdAt}))`,
      email: users.email,
    })
    .from(courseWants)
    .innerJoin(users, eq(users.id, courseWants.userId))
    .innerJoin(schools, eq(schools.id, courseWants.schoolId))
    .where(
      and(
        notExpired(courseWants.expiresAt, now),
        eq(users.isActive, 1),
        eq(users.isBanned, 0),
        isNull(users.deletedAt),
        sql`${users.email} <> ''`,
        sql`(${courseWants.schoolId} || ':' || ${courseWants.courseKey}) IN (SELECT value FROM json_each(${JSON.stringify([...newPairs.keys()])}))`,
      ),
    )
    .orderBy(asc(courseWants.createdAt))
    .limit(MAX_COURSE_WANTS_PER_RUN);
  if (!wants.length) return none;

  // 4. The listings those requests are about, newer than the oldest of them.
  const oldest = wants.reduce((m, w) => (w.since < m ? w.since : m), wants[0].since);
  const wantedNames = [...new Set(wants.flatMap((w) => newPairs.get(`${w.schoolId}:${w.key}`) ?? []))];
  const schoolIds = [...new Set(wants.map((w) => w.schoolId))];
  const fresh = await db
    .select({
      schoolId: listings.schoolId,
      courseName: listings.courseName,
      createdAt: listings.createdAt,
      bookId: books.id,
      title: books.title,
      isbn13: books.isbn13,
    })
    .from(listings)
    .innerJoin(books, eq(books.id, listings.bookId))
    .where(
      and(
        eq(listings.status, 'active'),
        gt(listings.createdAt, oldest),
        sql`${listings.schoolId} IN (SELECT value FROM json_each(${JSON.stringify(schoolIds)}))`,
        sql`${listings.courseName} IN (SELECT value FROM json_each(${JSON.stringify(wantedNames)}))`,
      ),
    )
    .orderBy(asc(listings.createdAt))
    .limit(MAX_COURSE_LISTINGS_PER_RUN);
  const listed = fresh.map((l) => ({ ...l, key: courseKey(l.courseName) }));

  type Due = { want: (typeof wants)[number]; books: Map<string, { id: string; title: string; isbn13: string | null }> };
  const byUser = new Map<string, Due[]>();
  for (const want of wants) {
    const hits = listed.filter((l) => l.schoolId === want.schoolId && l.key === want.key && l.createdAt > want.since);
    if (!hits.length) continue;
    const due: Due = { want, books: new Map(hits.map((h) => [h.bookId, { id: h.bookId, title: h.title, isbn13: h.isbn13 }])) };
    const list = byUser.get(want.userId);
    if (list) list.push(due);
    else byUser.set(want.userId, [due]);
  }

  let notifiedUsers = 0;
  let notifiedWants = 0;
  for (const dues of [...byUser.values()].slice(0, MAX_NOTIFY_USERS_PER_RUN)) {
    const first = dues[0].want;
    const bookList = new Map<string, { id: string; title: string; isbn13: string | null }>();
    for (const d of dues) for (const [id, b] of d.books) bookList.set(id, b);
    const sent = await sendWaitlistNotice(env, {
      job: 'CourseWaitNotify',
      userId: first.userId,
      email: first.email,
      region: first.regionCode,
      // The request and the moment it was last told about: told again only for listings newer than that.
      dedupeIds: dues.map((d) => `${d.want.id}@${d.want.since}`),
      courseName: dues.map((d) => d.want.name).join('、'),
      courses: dues.map((d) => ({ name: d.want.name, school: d.want.schoolCode })),
      books: [...bookList.values()],
    });
    if (!sent) continue;
    try {
      await db
        .update(courseWants)
        .set({ notifiedAt: now })
        .where(sql`${courseWants.id} IN (SELECT value FROM json_each(${JSON.stringify(dues.map((d) => d.want.id))}))`);
    } catch (e) {
      console.error(`[CourseWaitNotify] could not mark user ${first.userId} notified`, e);
      continue;
    }
    notifiedUsers++;
    notifiedWants += dues.length;
  }

  const result = { notified_users: notifiedUsers, notified_course_wants: notifiedWants };
  console.log('[CourseWaitNotify]', JSON.stringify(result));
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
      // One reminder per person per agreed meetup, however many runs see it due.
      const dedupeKey = `meetup:${order.id}:${user.id}:${meetupTime}`;
      const email: EmailMessage = {
        type: 'meetup_reminder',
        dedupe_key: dedupeKey,
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
          dedupe_key: dedupeKey,
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
// Verification expiry reminders ('0 3 * * *')
// ---------------------------------------------------------------------------

export const MAX_EXPIRY_REMINDERS_PER_RUN = 50;
/** How long before a verification expires its reminder goes out (the settings page offers renewal from then too). */
export const EXPIRY_REMINDER_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Mail each student whose campus verification runs out within 30 days, once
 * per expiry: expiry_reminded_for records the expires_at reminded about, and
 * a renewal moves expires_at on, so the next cycle is due again by itself.
 */
export async function runVerificationExpiryReminder(env: Env) {
  const db = createDb(env.DB);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const windowEnd = new Date(nowMs + EXPIRY_REMINDER_LEAD_MS).toISOString();

  const dueWhere = and(
    eq(regionVerifications.isActive, 1),
    gt(regionVerifications.expiresAt, now),
    lte(regionVerifications.expiresAt, windowEnd),
    or(isNull(regionVerifications.expiryRemindedFor), ne(regionVerifications.expiryRemindedFor, regionVerifications.expiresAt)),
    // Nobody to mail: left due, they would hold batch slots until they lapse.
    eq(users.isActive, 1),
    eq(users.isBanned, 0),
    isNull(users.deletedAt),
    sql`${users.email} <> ''`,
  );
  const rows = await db
    .select({
      id: regionVerifications.id,
      userId: regionVerifications.userId,
      regionCode: regionVerifications.regionCode,
      eduEmail: regionVerifications.eduEmail,
      expiresAt: regionVerifications.expiresAt,
    })
    .from(regionVerifications)
    .innerJoin(users, eq(users.id, regionVerifications.userId))
    .where(dueWhere)
    .orderBy(asc(regionVerifications.expiresAt))
    .limit(MAX_EXPIRY_REMINDERS_PER_RUN + 1);
  const batch = rows.slice(0, MAX_EXPIRY_REMINDERS_PER_RUN);

  let reminded = 0;
  for (const v of batch) {
    const expiresAt = v.expiresAt!;
    const email: EmailMessage = {
      type: 'verification_expiry',
      dedupe_key: `verification-expiry:${v.id}:${expiresAt}`,
      user_id: v.userId,
      region: v.regionCode,
      edu_email: v.eduEmail,
      expires_at: expiresAt,
    };
    try {
      await env.EMAIL_QUEUE.send(email);
    } catch (e) {
      console.error(`[VerificationExpiryReminder] enqueue failed for verification ${v.id}`, e);
      continue;
    }
    try {
      // Only while it is still the expiry reminded about: a renewal meanwhile is left due for its own cycle.
      await db
        .update(regionVerifications)
        .set({ expiryRemindedFor: expiresAt })
        .where(and(eq(regionVerifications.id, v.id), eq(regionVerifications.expiresAt, expiresAt)));
    } catch (e) {
      console.error(`[VerificationExpiryReminder] could not mark verification ${v.id} reminded`, e);
      continue;
    }
    reminded++;
  }

  const result = { reminded, more_remain: rows.length > MAX_EXPIRY_REMINDERS_PER_RUN };
  console.log('[VerificationExpiryReminder]', JSON.stringify(result));
  return result;
}

export async function purgeExpiredStudentIdVerifications(env: Env): Promise<number> {
  const db = createDb(env.DB);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const expired = await db
    .select({ id: studentIdVerifications.id, imageKey: studentIdVerifications.imageKey })
    .from(studentIdVerifications)
    .where(and(eq(studentIdVerifications.status, 'pending'), lt(studentIdVerifications.createdAt, thirtyDaysAgo)));

  const now = new Date().toISOString();
  let cancelledCount = 0;
  for (const item of expired) {
    if (item.imageKey) {
      await env.R2_PRIVATE.delete(item.imageKey).catch((e) =>
        console.error(`[StudentIdCleanup] failed to delete image ${item.imageKey}`, e),
      );
    }
    await db
      .update(studentIdVerifications)
      .set({
        status: 'cancelled',
        rejectReason: 'acct.studentIdExpired',
        imageKey: null,
        updatedAt: now,
      })
      .where(and(eq(studentIdVerifications.id, item.id), eq(studentIdVerifications.status, 'pending')));
    cancelledCount++;
  }
  // Photos of decided requests whose delete failed at decision time.
  const leftovers = await db
    .select({ id: studentIdVerifications.id, imageKey: studentIdVerifications.imageKey })
    .from(studentIdVerifications)
    .where(and(ne(studentIdVerifications.status, 'pending'), isNotNull(studentIdVerifications.imageKey)));
  for (const item of leftovers) {
    try {
      await env.R2_PRIVATE.delete(item.imageKey!);
      await db.update(studentIdVerifications).set({ imageKey: null }).where(eq(studentIdVerifications.id, item.id));
    } catch (e) {
      console.error(`[StudentIdCleanup] failed to delete image ${item.imageKey}`, e);
    }
  }

  // Uploads that never became a request. The public bucket's tmp/ prefix is
  // reaped by a lifecycle rule; the private bucket has none, so do it here.
  const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  do {
    const page = await env.R2_PRIVATE.list({ prefix: 'tmp/student-ids/', cursor, limit: 500 });
    const stale = page.objects.filter((o) => o.uploaded.getTime() < dayAgoMs).map((o) => o.key);
    if (stale.length) await env.R2_PRIVATE.delete(stale);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return cancelledCount;
}

// ---------------------------------------------------------------------------
// Cleanup ('0 3 * * *')
// ---------------------------------------------------------------------------

/**
 * Delete book and course requests past their end date. They stopped counting the moment they
 * expired; this only frees the rows, and the books only a lapsed request kept in the catalogue.
 */
export async function purgeExpiredRequests(env: Env): Promise<number> {
  const db = createDb(env.DB);
  const now = new Date().toISOString();
  const [subs, courses] = await db.batch([
    db
      .delete(subscriptions)
      .where(sql`${subscriptions.expiresAt} IS NOT NULL AND ${subscriptions.expiresAt} <= ${now}`)
      .returning({ bookId: subscriptions.bookId }),
    db
      .delete(courseWants)
      .where(sql`${courseWants.expiresAt} IS NOT NULL AND ${courseWants.expiresAt} <= ${now}`)
      .returning({ id: courseWants.id }),
  ]);
  if (subs.length) await deleteUnusedBooks(env, [...new Set(subs.map((s) => s.bookId))]);
  return subs.length + courses.length;
}

/** Delete roster members whose membership has ended (valid_until before today). */
export async function purgeLapsedMembers(env: Env): Promise<number> {
  const res = await createDb(env.DB).delete(organizationMembers).where(lt(organizationMembers.validUntil, today())).run();
  return res.meta.changes ?? 0;
}

export async function runCleanup(env: Env) {
  const [{ total }] = await createDb(env.DB)
    .select({ total: sql<number>`count(*)` })
    .from(books);
  const db = createDb(env.DB);
  const orphansDeleted = await deleteUnusedBooks(env);
  const coverCleanup = await runCoverCleanup(env);
  const tokensPurged = await purgeTokenStore(env);
  const linksPurged = await purgeOneTimeTokens(env);
  const pendingAccountsPurged = await purgePendingRegistrations(env);
  const conversationsRemoved = await sweepDeletedConversations(env);
  const studentIdExpired = await purgeExpiredStudentIdVerifications(env);
  const requestsExpired = await purgeExpiredRequests(env);
  const membersLapsed = await purgeLapsedMembers(env);
  // Redelivery only happens within the queue's retry window, so a day is plenty.
  // A day covers a redelivery and the next run of every job that enqueues with a dedupe key (6 h at most).
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [sentPurged, pushSentPurged] = await db.batch([
    db.delete(emailSent).where(lt(emailSent.sentAt, dayAgo)),
    db.delete(pushSent).where(lt(pushSent.sentAt, dayAgo)),
  ]);
  // Throttle counters live in the RateLimiter Durable Object and expire on
  // their own, so there is nothing to purge here.
  const result = {
    orphan_books_deleted: orphansDeleted,
    scanned_books: Number(total),
    unlisted_covers_cleaned: coverCleanup.cleaned,
    refresh_tokens_purged: tokensPurged,
    one_time_tokens_purged: linksPurged,
    pending_accounts_purged: pendingAccountsPurged,
    conversations_removed: conversationsRemoved,
    student_id_verifications_expired: studentIdExpired,
    expired_requests_purged: requestsExpired,
    lapsed_members_purged: membersLapsed,
    email_sent_purged: sentPurged.meta.changes ?? 0,
    push_sent_purged: pushSentPurged.meta.changes ?? 0,
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
        await runAlone(env, 'CourseWaitNotify', () => runCourseWaitNotify(env));
        await runAlone(env, 'CoverSweep', () => runCoverSweep(env));
        break;
      case '*/30 * * * *':
        await runAlone(env, 'MeetupReminder', () => runMeetupReminder(env));
        await runAlone(env, 'AutoComplete', () => runAutoComplete(env));
        break;
      case '0 3 * * *':
        await runAlone(env, 'CoverCleanup', () => runCoverCleanup(env));
        await runAlone(env, 'Cleanup', () => runCleanup(env));
        await runAlone(env, 'VerificationExpiryReminder', () => runVerificationExpiryReminder(env));
        break;
      default:
        console.warn(`[cron] unhandled trigger ${controller.cron}`);
    }
  } catch (e) {
    console.error(`[cron] ${controller.cron} failed`, e);
    throw e;
  }
}
