import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Env } from '../../env';
import { createDb, orders, users, listings, books, reviews, conversations, regionVerifications, schools } from '../../db';
import { displayName } from '../accounts/users';

/**
 * The viewer's orders (as
 * buyer or seller) in one region, newest first, each with the other
 * party's name/avatar/school, whether the viewer has reviewed it, and the
 * conversation it was arranged in. One query for the page, however many rows.
 */

const buyerU = alias(users, 'order_buyer');
const sellerU = alias(users, 'order_seller');

function likeEscape(s: string) {
  return `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function schoolOf(userId: typeof orders.buyerId | typeof orders.sellerId, nowIso: string) {
  return sql<string | null>`(SELECT json_object('name', ${schools.name}, 'tr', ${schools.translations}) FROM ${regionVerifications}
    JOIN ${schools} ON ${schools.id} = ${regionVerifications.schoolId}
    WHERE ${regionVerifications.userId} = ${userId}
      AND ${regionVerifications.regionCode} = ${orders.regionCode}
      AND ${regionVerifications.isActive} = 1
      AND (${regionVerifications.expiresAt} IS NULL OR ${regionVerifications.expiresAt} > ${nowIso})
    LIMIT 1)`;
}

function baseWhere(viewerId: string, regionCode: string, opts: { id?: string; q?: string }) {
  const conds: SQL[] = [eq(orders.regionCode, regionCode), or(eq(orders.buyerId, viewerId), eq(orders.sellerId, viewerId))!];
  if (opts.id) conds.push(eq(orders.id, opts.id));
  if (opts.q) {
    const qClean = opts.q.replace(/^#+/, '').trim();
    const pat = likeEscape(opts.q);
    conds.push(
      sql`(${orders.id} LIKE ${likeEscape(qClean)} ESCAPE '\\'
        OR ${orders.bookTitle} LIKE ${pat} ESCAPE '\\'
        OR ${books.authors} LIKE ${pat} ESCAPE '\\'
        OR ${orders.bookIsbn} LIKE ${pat} ESCAPE '\\')`,
    );
  }
  return and(...conds)!;
}

function selection(viewerId: string, nowIso: string) {
  return {
    order: orders,
    bookAuthors: books.authors,
    buyerFirst: buyerU.firstName,
    buyerLast: buyerU.lastName,
    buyerAvatar: buyerU.avatarUrl,
    buyerShowAvatar: buyerU.showAvatar,
    sellerFirst: sellerU.firstName,
    sellerLast: sellerU.lastName,
    sellerAvatar: sellerU.avatarUrl,
    sellerShowAvatar: sellerU.showAvatar,
    buyerSchool: schoolOf(orders.buyerId, nowIso),
    sellerSchool: schoolOf(orders.sellerId, nowIso),
    hasReviewed: sql<number>`EXISTS (SELECT 1 FROM ${reviews} WHERE ${reviews.orderId} = ${orders.id} AND ${reviews.reviewerId} = ${viewerId})`,
    // The order's own buyer/seller conversation, unless the viewer deleted it
    // from their inbox: the messages page only
    // opens chats in that inbox, so a link would lead nowhere.
    conversationId: sql<string | null>`(SELECT ${conversations.id} FROM ${conversations}
      WHERE ${conversations.buyerId} = ${orders.buyerId}
        AND (${conversations.listingRef} = ${orders.listingRef}
             OR (${orders.listingId} IS NOT NULL AND ${conversations.listingId} = ${orders.listingId}))
        AND NOT ((${conversations.buyerId} = ${viewerId} AND ${conversations.buyerDeletedAt} IS NOT NULL)
              OR (${conversations.sellerId} = ${viewerId} AND ${conversations.sellerDeletedAt} IS NOT NULL))
      LIMIT 1)`,
  };
}

type Row = Awaited<ReturnType<typeof runSelect>>[number];

function runSelect(env: Env, viewerId: string, where: SQL, limit: number, offset: number) {
  const nowIso = new Date().toISOString();
  return createDb(env.DB)
    .select(selection(viewerId, nowIso))
    .from(orders)
    .leftJoin(listings, eq(listings.id, orders.listingId))
    .leftJoin(books, eq(books.id, listings.bookId))
    .innerJoin(buyerU, eq(buyerU.id, orders.buyerId))
    .innerJoin(sellerU, eq(sellerU.id, orders.sellerId))
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(limit)
    .offset(offset);
}

/** The translation of `field` for `lang` (exact tag, then its base language), else `fallback`. */
export function localizedField(translations: string | null | undefined, lang: string | null, field: string, fallback: string): string {
  if (!lang || !translations) return fallback;
  let map: unknown;
  try {
    map = JSON.parse(translations);
  } catch {
    return fallback;
  }
  if (!map || typeof map !== 'object') return fallback;
  const m = map as Record<string, Record<string, unknown> | undefined>;
  const base = lang.split('-')[0].toLowerCase();
  const hit =
    m[lang] ?? Object.entries(m).find(([k]) => k.toLowerCase() === lang.toLowerCase() || k.split('-')[0].toLowerCase() === base)?.[1];
  const v = hit && typeof hit === 'object' ? hit[field] : undefined;
  return typeof v === 'string' && v ? v : fallback;
}

function schoolName(raw: string | null, lang: string | null): string {
  if (!raw) return '';
  try {
    const { name, tr } = JSON.parse(raw) as { name?: string; tr?: string };
    return localizedField(tr, lang, 'name', name ?? '');
  } catch {
    return '';
  }
}

export function serializeOrder(r: Row, lang: string | null) {
  const o = r.order;
  return {
    id: o.id,
    listing_title: o.bookTitle,
    listing_deleted: o.listingId === null,
    book_authors: r.bookAuthors ?? '',
    buyer_name: displayName(r.buyerFirst, r.buyerLast),
    seller_name: displayName(r.sellerFirst, r.sellerLast),
    has_reviewed: !!r.hasReviewed,
    buyer_avatar_url: r.buyerShowAvatar ? (r.buyerAvatar ?? '') : '',
    seller_avatar_url: r.sellerShowAvatar ? (r.sellerAvatar ?? '') : '',
    buyer_school_name: schoolName(r.buyerSchool, lang),
    seller_school_name: schoolName(r.sellerSchool, lang),
    conversation_id: r.conversationId ?? null,
    region: o.regionCode,
    currency: o.currencyCode,
    buyer: o.buyerId,
    seller: o.sellerId,
    listing: o.listingId,
    listing_ref: o.listingRef,
    book_title: o.bookTitle,
    book_isbn: o.bookIsbn,
    status: o.status,
    cancel_reason: o.cancelReason,
    total_amount: o.totalAmount,
    meetup_time: o.meetupTime,
    meetup_location: o.meetupLocation,
    meetup_reminder_sent_at: o.meetupReminderSentAt,
    buyer_reminder_sent_at: o.buyerReminderSentAt,
    seller_reminder_sent_at: o.sellerReminderSentAt,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    completed_at: o.completedAt,
  };
}

export type SerializedOrder = ReturnType<typeof serializeOrder>;

export async function listOrders(
  env: Env,
  viewerId: string,
  regionCode: string,
  opts: { q?: string; limit: number; offset: number; lang: string | null },
): Promise<{ rows: SerializedOrder[]; count: number }> {
  const where = baseWhere(viewerId, regionCode, { q: opts.q });
  const db = createDb(env.DB);
  const [rows, [{ n }]] = await Promise.all([
    runSelect(env, viewerId, where, opts.limit, opts.offset),
    db
      .select({ n: sql<number>`count(*)` })
      .from(orders)
      .leftJoin(listings, eq(listings.id, orders.listingId))
      .leftJoin(books, eq(books.id, listings.bookId))
      .where(where),
  ]);
  return { rows: rows.map((r) => serializeOrder(r, opts.lang)), count: Number(n) };
}

/** One of the viewer's orders in `regionCode`, serialized; null when not theirs / not there. */
export async function getOrderFor(
  env: Env,
  viewerId: string,
  regionCode: string,
  id: string,
  lang: string | null,
): Promise<SerializedOrder | null> {
  const [row] = await runSelect(env, viewerId, baseWhere(viewerId, regionCode, { id }), 1, 0);
  return row ? serializeOrder(row, lang) : null;
}
