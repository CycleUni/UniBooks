import { Hono, type Context } from 'hono';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppEnv } from '../env';
import { createDb, orders, listings, books, conversations, reviews, users } from '../db';
import { authMiddleware } from '../middleware/auth';
import { getRegion, assertVerifiedIn } from '../lib/region';
import { apiError, fieldErrors, notFound, pagination, readJson } from '../lib/http';
import { listOrders, getOrderFor } from '../services/orders/serialize';
import { resolveLanguage } from '../services/accounts/i18n';
import type { LockedResult } from '../services/orders/transitions';
import { lockKeyFor } from '../services/orders/transitions';
import { orderLock } from '../services/orders/lock';
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
  if (order) await assertVerifiedIn(c, order.regionCode);

  // Field validation, then cross-field checks.
  const errors: Record<string, string[]> = {};
  if (!provided) errors.order = ['common.errValidation'];
  const isNoShow = parseBool(data.is_no_show);
  if (isNoShow === undefined) errors.is_no_show = ['common.errValidation'];
  let comment = '';
  if ('comment' in data) {
    if (typeof data.comment === 'string' && data.comment.length <= 2000) comment = data.comment;
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

  const raw = data.listing;
  if (raw === undefined || raw === null || raw === '') fieldErrors({ listing: ['common.errValidation'] });
  const listingId = typeof raw === 'string' && UUID_LOOSE_RE.test(raw) ? normUuid(raw) : null;
  const [listing] = listingId
    ? await db
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
        .where(eq(listings.id, listingId))
        .limit(1)
    : [];

  // Must be verified in the listing's region (checked before validation).
  if (listing) await assertVerifiedIn(c, listing.regionCode);
  if (!listing) fieldErrors({ listing: ['checkout.errListingUnavailable'] });

  // Cross-field checks.
  if (listing.status !== 'active') fieldErrors({ listing: ['checkout.errListingUnavailable'] });
  const region = await getRegion(c);
  if (region && region.code !== listing.regionCode) fieldErrors({ listing: ['checkout.errRegionMismatch'] });
  if (user.id === listing.sellerId) fieldErrors({ listing: ['checkout.errOwnListing'] });
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.buyerId, user.id), eq(conversations.listingId, listing.id)))
    .limit(1);
  if (!conv) fieldErrors({ listing: ['checkout.errNoChat'] });

  // Amount, region and currency come from the listing, never the request.
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  // The partial unique index orders_open_buyer_listing_uniq refuses a second
  // open order from the same buyer on the same listing.
  const inserted = await db
    .insert(orders)
    .values({
      id,
      regionCode: listing.regionCode,
      currencyCode: listing.currencyCode,
      listingId: listing.id,
      listingRef: listing.id,
      bookTitle: (listing.title ?? '').slice(0, 255),
      bookIsbn: listing.isbn13 ?? '',
      buyerId: user.id,
      sellerId: listing.sellerId,
      status: 'pending',
      totalAmount: listing.price,
      meetupLocation: '',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: orders.id });
  if (!inserted.length) fieldErrors({ listing: ['checkout.errListingUnavailable'] });

  const notice = {
    id,
    buyerId: user.id,
    sellerId: listing.sellerId,
    listingId: listing.id,
    listingRef: listing.id,
    bookTitle: listing.title ?? '',
    status: 'pending',
  };
  // Best-effort (never throws).
  await deliverNotices(c.env, notice, [{ key: 'order.notify.meetup_requested', senderId: user.id, push: true }]);

  const body = await getOrderFor(c.env, user.id, listing.regionCode, id, await resolveLanguage(c));
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
  await assertVerifiedIn(c, o.regionCode);
  const data = await readJson(c.req);

  const res = (await orderLock(c.env, lockKeyFor(o)).updateOrder({ orderId: o.id, actorId: userId, data })) as LockedResult;
  if (!res.ok) apiError(res.status, res.code, res.fields && { fields: res.fields });

  // Chat notices are network calls: they go once the write has committed
  // and the lock is free, and never fail the request.
  await deliverNotices(c.env, res.order, res.notices);

  const body = await getOrderFor(c.env, userId, o.regionCode, o.id, await resolveLanguage(c));
  return body ? c.json(body) : notFound(c);
});
