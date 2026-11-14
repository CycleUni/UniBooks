import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppEnv } from '../env';
import { createDb, orders, orderItems, listings, books, conversations, conversationListings, reviews, users } from '../db';
import { authMiddleware } from '../middleware/auth';
import { getRegion, assertMayTrade } from '../lib/region';
import { apiError, fieldErrors, notFound, pagination, readJson } from '../lib/http';
import { LIMITS } from '../lib/limits';
import { listOrders, getOrderFor } from '../services/orders/serialize';
import { resolveLanguage } from '../services/accounts/i18n';
import type { LockedResult } from '../services/orders/transitions';
import { lockKeyFor } from '../services/orders/transitions';
import { orderLock } from '../services/orders/lock';
import { isUniqueViolation } from '../lib/db';
import { deliverNotices } from '../services/orders/notify';
import { checkRate } from '../middleware/rateLimit';
import { UUID_LOOSE_RE, normUuid } from '../lib/uuid';

/**
 * /api/v1/orders:
 *   reviews/        (GET list, POST create)
 *   reviews/<id>/   (GET retrieve)
 *   ''              (GET list, POST create)
 *   <id>/           (GET retrieve, PATCH status / meetup)
 * All need a signed-in user, and writes a user verified in the listing's /
 * order's region. Orders cannot be deleted or PUT, reviews are write-once:
 * those methods answer 405.
 */
export const orderRoutes = new Hono<AppEnv>();

orderRoutes.use('*', authMiddleware());

/** Answer 400 with a single (un-listed) field error: {"order": "code"}. */
function plainFieldError(c: Context<AppEnv>, field: string, code: string) {
  return c.json({ [field]: code }, 400);
}

// ---------------------------------------------------------------------------
// Reviews (registered first, so /reviews/ is not taken for an order id)
// ---------------------------------------------------------------------------

const reviewer = alias(users, 'review_reviewer');
const reviewee = alias(users, 'review_reviewee');

function reviewSelect(c: Context<AppEnv>) {
  return createDb(c.env.DB)
    .select({
      review: reviews,
      reviewerName: reviewer.name,
      revieweeName: reviewee.name,
    })
    .from(reviews)
    .innerJoin(reviewer, eq(reviewer.id, reviews.reviewerId))
    .innerJoin(reviewee, eq(reviewee.id, reviews.revieweeId));
}

type ReviewRow = Awaited<ReturnType<ReturnType<typeof reviewSelect>['limit']>>[number];

function serializeReview(r: ReviewRow) {
  const v = r.review;
  return {
    id: v.id,
    reviewer_name: r.reviewerName ?? '',
    reviewee_name: r.revieweeName ?? '',
    order: v.orderId,
    reviewer: v.reviewerId,
    reviewee: v.revieweeId,
    rating: v.rating,
    comment: v.comment,
    is_no_show: !!v.isNoShow,
    created_at: v.createdAt,
  };
}

const mine = (userId: string) => or(eq(reviews.reviewerId, userId), eq(reviews.revieweeId, userId))!;

orderRoutes.get('/reviews', async (c) => {
  const userId = c.get('userId')!;
  const page = pagination(c.req.url);
  const db = createDb(c.env.DB);
  const [rows, [{ n }]] = await Promise.all([
    reviewSelect(c).where(mine(userId)).orderBy(desc(reviews.createdAt), desc(reviews.id)).limit(page.limit).offset(page.offset),
    db
      .select({ n: sql<number>`count(*)` })
      .from(reviews)
      .where(mine(userId)),
  ]);
  return c.json(page.wrap(rows.map(serializeReview), Number(n)));
});

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
  }
  return undefined;
}

function parseRating(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.0*)?$/.test(v.trim())) return Number.parseInt(v, 10);
  return undefined;
}

orderRoutes.post('/reviews', async (c) => {
  const user = c.get('user')!;
  const data = await readJson(c.req);
  const db = createDb(c.env.DB);

  // Existence and ownership first, so a stranger cannot probe which order ids exist (or which
  // regions they sit in): anything that is not the caller's own order is a plain 404.
  const rawOrder = data.order;
  const orderId = typeof rawOrder === 'string' && UUID_LOOSE_RE.test(rawOrder) ? normUuid(rawOrder) : null;
  const [order] = orderId ? await db.select().from(orders).where(eq(orders.id, orderId)).limit(1) : [];
  const provided = rawOrder !== undefined && rawOrder !== null && rawOrder !== '';
  if (provided && (!order || (user.id !== order.buyerId && user.id !== order.sellerId))) return notFound(c);
  if (order) await assertMayTrade(c, order.regionCode);

  // Field validation, then cross-field checks.
  const errors: Record<string, string[]> = {};
  if (!provided) errors.order = ['common.errValidation'];
  const isNoShow = parseBool(data.is_no_show);
  if (isNoShow === undefined) errors.is_no_show = ['common.errValidation'];
  let comment = '';
  if ('comment' in data) {
    if (typeof data.comment === 'string' && data.comment.length <= LIMITS.reviewComment) comment = data.comment;
    else errors.comment = ['common.errValidation'];
  }
  let rating = parseRating(data.rating);
  if (rating === undefined) errors.rating = ['order.errRatingRange'];
  if (Object.keys(errors).length) fieldErrors(errors);
  if (isNoShow)
    rating = null; // a no-show report carries no rating
  else if (rating === null || rating === undefined || rating < 1 || rating > 5) fieldErrors({ rating: ['order.errRatingRange'] });

  // Who may review, and when.
  if (isNoShow && order!.status !== 'cancelled') return plainFieldError(c, 'order', 'order.errNoShowNeedsCancelled');
  // Only a cancel made after the agreed meetup time had
  // passed (services/orders/transitions.ts) can be followed by a no-show
  // report — not a pending request withdrawn or declined, not a platform
  // cancel, not a party backing out early and then blaming the other.
  if (isNoShow && !order!.noShowReportable) return plainFieldError(c, 'order', 'order.errNoShowNeedsCancelled');
  if (!isNoShow && order!.status !== 'completed') return plainFieldError(c, 'order', 'order.errReviewNeedsCompleted');
  const revieweeId = user.id === order!.buyerId ? order!.sellerId : order!.buyerId;

  // One per party per order; the unique index settles a double submit.
  const inserted = await db
    .insert(reviews)
    .values({
      orderId: order!.id,
      reviewerId: user.id,
      revieweeId,
      rating: rating ?? null,
      comment,
      isNoShow: isNoShow ? 1 : 0,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: reviews.id });
  if (!inserted.length) return plainFieldError(c, 'order', 'order.errAlreadyReviewed');

  const [row] = await reviewSelect(c).where(eq(reviews.id, inserted[0].id)).limit(1);
  return c.json(serializeReview(row), 201);
});

orderRoutes.get('/reviews/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id)) return notFound(c);
  const [row] = await reviewSelect(c)
    .where(and(eq(reviews.id, id), mine(c.get('userId')!)))
    .limit(1);
  return row ? c.json(serializeReview(row)) : notFound(c);
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

orderRoutes.get('/', async (c) => {
  const userId = c.get('userId')!;
  const page = pagination(c.req.url);
  const region = await getRegion(c);
  if (!region) return c.json(page.wrap([], 0));
  const q = c.req.query('q') || undefined;
  const lang = await resolveLanguage(c);
  const { rows, count } = await listOrders(c.env, userId, region.code, { q, limit: page.limit, offset: page.offset, lang });
  return c.json(page.wrap(rows, count));
});

orderRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  // Each order posts a notice to the seller (chat + push/email); cap the rate.
  await checkRate(c, 'order_create', '20/hour');
  const data = await readJson(c.req);
  const db = createDb(c.env.DB);

  const rawListing = data.listing;
  const rawListingIds = data.listing_ids;
  const rawConv = data.conversation_id;

  if (rawListing === undefined && rawListingIds === undefined) {
    fieldErrors({ listing: ['common.errValidation'] });
  }

  const isMulti = rawListingIds !== undefined;

  let distinctIds: string[] = [];
  if (isMulti) {
    if (!Array.isArray(rawListingIds)) {
      fieldErrors({ listing_ids: ['common.errValidation'] });
    }
    if (rawListingIds.length < 1 || rawListingIds.length > 10) {
      fieldErrors({ listing_ids: ['checkout.errItemCount'] });
    }
    for (const raw of rawListingIds) {
      if (typeof raw !== 'string' || !UUID_LOOSE_RE.test(raw)) {
        fieldErrors({ listing_ids: ['common.errValidation'] });
      }
      const id = normUuid(raw);
      if (!distinctIds.includes(id)) distinctIds.push(id);
    }
    if (distinctIds.length < 1 || distinctIds.length > 10) {
      fieldErrors({ listing_ids: ['checkout.errItemCount'] });
    }
  } else {
    if (rawListing === undefined || rawListing === null || rawListing === '') {
      fieldErrors({ listing: ['common.errValidation'] });
    }
    const listingId = typeof rawListing === 'string' && UUID_LOOSE_RE.test(rawListing) ? normUuid(rawListing) : null;
    if (!listingId) fieldErrors({ listing: ['checkout.errListingUnavailable'] });
    distinctIds = [listingId!];
  }

  let convId: string | null = null;
  if (rawConv !== undefined && rawConv !== null && rawConv !== '') {
    if (typeof rawConv !== 'string' || !UUID_LOOSE_RE.test(rawConv)) {
      fieldErrors({ conversation_id: ['common.errValidation'] });
    }
    convId = normUuid(rawConv);
  }

  // Fetch all requested listings
  const foundRows = await db
    .select({
      id: listings.id,
      status: listings.status,
      regionCode: listings.regionCode,
      currencyCode: listings.currencyCode,
      sellerId: listings.sellerId,
      price: listings.price,
      title: books.title,
      isbn13: books.isbn13,
    })
    .from(listings)
    .innerJoin(books, eq(books.id, listings.bookId))
    .where(inArray(listings.id, distinctIds));

  const listingMap = new Map(foundRows.map((l) => [l.id, l]));

  // Check missing
  const unavailableErrors: Record<string, string[]> = {};
  for (const id of distinctIds) {
    if (!listingMap.has(id)) {
      unavailableErrors[isMulti ? id : 'listing'] = ['checkout.errListingUnavailable'];
    }
  }
  if (Object.keys(unavailableErrors).length) fieldErrors(unavailableErrors);

  const orderedListings = distinctIds.map((id) => listingMap.get(id)!);
  const firstListing = orderedListings[0];

  // Must be allowed to trade in the listings' region (checked before validation).
  await assertMayTrade(c, firstListing.regionCode);

  const region = await getRegion(c);
  const mismatchErrors: Record<string, string[]> = {};
  for (const l of orderedListings) {
    if ((region && l.regionCode !== region.code) || l.regionCode !== firstListing.regionCode) {
      mismatchErrors[isMulti ? l.id : 'listing'] = ['checkout.errRegionMismatch'];
    }
    if (user.id === l.sellerId) {
      mismatchErrors[isMulti ? l.id : 'listing'] = ['checkout.errOwnListing'];
    }
  }
  if (Object.keys(mismatchErrors).length) fieldErrors(mismatchErrors);

  if (orderedListings.some((l) => l.sellerId !== firstListing.sellerId)) {
    fieldErrors({ listing_ids: ['checkout.errMixedSellers'] });
  }

  // Check status and duplicate open order for this buyer
  const openItems = await db
    .select({ listingId: orderItems.listingId })
    .from(orderItems)
    .where(and(eq(orderItems.buyerId, user.id), eq(orderItems.isOpen, 1), inArray(orderItems.listingId, distinctIds)));
  const openListingIds = new Set(openItems.map((oi) => oi.listingId));

  for (const l of orderedListings) {
    if (l.status !== 'active' || openListingIds.has(l.id)) {
      unavailableErrors[isMulti ? l.id : 'listing'] = ['checkout.errListingUnavailable'];
    }
  }
  if (Object.keys(unavailableErrors).length) fieldErrors(unavailableErrors);

  // Conversation scoping check
  if (convId) {
    const [conv] = await db
      .select({ id: conversations.id, listingId: conversations.listingId, listingRef: conversations.listingRef })
      .from(conversations)
      .where(and(eq(conversations.id, convId), eq(conversations.buyerId, user.id), eq(conversations.sellerId, firstListing.sellerId)))
      .limit(1);
    if (!conv) fieldErrors({ conversation_id: ['checkout.errNoChat'] });

    const convListings = await db
      .select({ listingId: conversationListings.listingId, listingRef: conversationListings.listingRef })
      .from(conversationListings)
      .where(eq(conversationListings.conversationId, conv.id));
    const attachedIds = new Set<string>();
    if (conv.listingId) attachedIds.add(conv.listingId);
    if (conv.listingRef) attachedIds.add(conv.listingRef);
    for (const cl of convListings) {
      if (cl.listingId) attachedIds.add(cl.listingId);
      if (cl.listingRef) attachedIds.add(cl.listingRef);
    }

    const chatErrors: Record<string, string[]> = {};
    for (const id of distinctIds) {
      if (!attachedIds.has(id)) {
        chatErrors[isMulti ? id : 'listing'] = ['checkout.errNoChat'];
      }
    }
    if (Object.keys(chatErrors).length) fieldErrors(chatErrors);
  } else {
    const userConvs = await db
      .select({ id: conversations.id, listingId: conversations.listingId, listingRef: conversations.listingRef })
      .from(conversations)
      .where(and(eq(conversations.buyerId, user.id), eq(conversations.sellerId, firstListing.sellerId)));
    const userConvIds = userConvs.map((cv) => cv.id);
    const userConvListings =
      userConvIds.length > 0
        ? await db
            .select({ listingId: conversationListings.listingId, listingRef: conversationListings.listingRef })
            .from(conversationListings)
            .where(inArray(conversationListings.conversationId, userConvIds))
        : [];

    const coveredIds = new Set<string>();
    for (const cv of userConvs) {
      if (cv.listingId) coveredIds.add(cv.listingId);
      if (cv.listingRef) coveredIds.add(cv.listingRef);
    }
    for (const cl of userConvListings) {
      if (cl.listingId) coveredIds.add(cl.listingId);
      if (cl.listingRef) coveredIds.add(cl.listingRef);
    }

    const chatErrors: Record<string, string[]> = {};
    for (const id of distinctIds) {
      if (!coveredIds.has(id)) {
        chatErrors[isMulti ? id : 'listing'] = ['checkout.errNoChat'];
      }
    }
    if (Object.keys(chatErrors).length) fieldErrors(chatErrors);
  }

  // Placing an order reserves nothing (the seller's accept does, under the
  // listing lock), so there is nothing to lock here: the order and its items
  // go in as one batch, and the partial unique indexes refuse a second open
  // order of this buyer on any of the listings, leaving nothing behind.
  const totalAmount = orderedListings.reduce((sum, l) => sum + l.price, 0);
  const primary = orderedListings[0];
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  try {
    await db.batch([
      db.insert(orders).values({
        id: orderId,
        regionCode: primary.regionCode,
        currencyCode: primary.currencyCode,
        listingId: primary.id,
        listingRef: primary.id,
        bookTitle: (primary.title ?? '').slice(0, 255),
        bookIsbn: primary.isbn13 ?? '',
        buyerId: user.id,
        sellerId: primary.sellerId,
        status: 'pending',
        totalAmount,
        meetupLocation: '',
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(orderItems).values(
        orderedListings.map((l) => ({
          id: crypto.randomUUID(),
          orderId,
          listingId: l.id,
          listingRef: l.id,
          bookTitle: (l.title ?? '').slice(0, 255),
          bookIsbn: l.isbn13 ?? '',
          price: l.price,
          buyerId: user.id,
          isOpen: 1,
          createdAt: now,
        })),
      ),
    ]);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    fieldErrors({ [isMulti ? primary.id : 'listing']: ['checkout.errListingUnavailable'] });
  }

  // The count rides on the title in a form that needs no translation.
  const noticeTitle = orderedListings.length > 1 ? `${primary.title ?? ''} (+${orderedListings.length - 1})` : (primary.title ?? '');
  const notice = {
    id: orderId,
    buyerId: user.id,
    sellerId: primary.sellerId,
    listingId: primary.id,
    listingRef: primary.id,
    bookTitle: noticeTitle,
    status: 'pending',
  };
  // Best-effort (never throws).
  await deliverNotices(c.env, notice, [{ key: 'order.notify.meetup_requested', senderId: user.id, push: true }]);

  const body = await getOrderFor(c.env, user.id, primary.regionCode, orderId, await resolveLanguage(c));
  return c.json(body, 201);
});

/** The viewer's order in the request's region. */
async function findVisibleOrder(c: Context<AppEnv>, rawId: string) {
  if (!UUID_LOOSE_RE.test(rawId)) return null;
  const region = await getRegion(c);
  if (!region) return null;
  const userId = c.get('userId')!;
  const [o] = await createDb(c.env.DB)
    .select({ id: orders.id, listingId: orders.listingId, regionCode: orders.regionCode })
    .from(orders)
    .where(
      and(eq(orders.id, normUuid(rawId)), eq(orders.regionCode, region.code), or(eq(orders.buyerId, userId), eq(orders.sellerId, userId))),
    )
    .limit(1);
  return o ?? null;
}

orderRoutes.get('/:id', async (c) => {
  const o = await findVisibleOrder(c, c.req.param('id'));
  if (!o) return notFound(c);
  const body = await getOrderFor(c.env, c.get('userId')!, o.regionCode, o.id, await resolveLanguage(c));
  return body ? c.json(body) : notFound(c);
});

orderRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId')!;
  // A meetup edit posts a notice to the other party's chat; cap how often.
  // Generous: a seller accepting and handing over many orders stays well under.
  await checkRate(c, 'order_update', '60/hour');
  const o = await findVisibleOrder(c, c.req.param('id'));
  if (!o) return notFound(c);
  await assertMayTrade(c, o.regionCode);
  const data = await readJson(c.req);

  const res = (await orderLock(c.env, lockKeyFor(o)).updateOrder({ orderId: o.id, actorId: userId, data })) as LockedResult;
  if (!res.ok) apiError(res.status, res.code, res.fields && { fields: res.fields });

  // Chat notices are network calls: they go once the write has committed
  // and the lock is free, and never fail the request.
  await deliverNotices(c.env, res.order, res.notices);

  const body = await getOrderFor(c.env, userId, o.regionCode, o.id, await resolveLanguage(c));
  return body ? c.json(body) : notFound(c);
});
