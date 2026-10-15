import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import {
  advertiserRegions,
  advertisers,
  ads,
  books,
  createAdsDb,
  categories,
  chatReports,
  conversations,
  createDb,
  listings,
  orders,
  regionVerifications,
  regions,
  reports,
  reviews,
  schools,
  subscriptions,
  users,
  type Book,
  type Database,
  type Region,
} from '../../db';
import { apiError, pagination } from '../../lib/http';
import { parseJsonObject } from '../../lib/json';
import { localized, resolveLanguage } from '../../services/admin/i18n';
import { notFound, scopeOf, uuidId } from '../../services/admin/scope';
import { regionAdTotals } from '../../services/admin/adAnalytics';
import {
  ALLOWED_DAYS,
  CompetitionRank,
  DEFAULT_DAYS,
  median,
  periodStart,
  ratio,
  roundHalfEven,
  roundInt,
  safeTimeZone,
  SeriesBuckets,
  termIndex,
  termLabel,
} from '../../services/admin/statsTime';

/**
 * Every endpoint answers for exactly one region (?region=, required): an
 * order's total_amount is in its region's currency, so amounts of two
 * regions never meet in one sum. "Period" (?days=) filters on created_at.
 * Figures are counted, summed and grouped in SQL; see the queries below.
 */
export const statsRoutes = new Hono<AppEnv>();

const INVALID = 'admin.errInvalidField';
const ORDER_STATUSES = ['pending', 'accepted', 'handed_over', 'completed', 'cancelled'] as const;
const LISTING_STATUSES = ['active', 'reserved', 'sold', 'removed'] as const;
const SORT_FIELDS = { completed: 'completed_count', gmv: 'gmv', orders: 'order_count' } as const;
type SortField = (typeof SORT_FIELDS)[keyof typeof SORT_FIELDS];
const DAY_SECONDS = 86400;

const invalid = (): never => apiError(400, INVALID);

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

async function resolveStatsRegion(c: Context<AppEnv>, db: Database): Promise<Region & { tz: string }> {
  const code = (c.req.query('region') ?? '').trim().toUpperCase();
  if (!code) invalid();
  const [region] = await db.select().from(regions).where(eq(regions.code, code)).limit(1);
  if (!region) invalid();
  const scope = await scopeOf(c);
  if (scope !== null && !scope.includes(region.code)) apiError(403, 'admin.errRegionForbidden');
  return { ...region, tz: safeTimeZone(region.timezone) };
}

function parseDays(c: Context<AppEnv>): number {
  const raw = c.req.query('days');
  if (raw === undefined || raw === '') return DEFAULT_DAYS;
  if (!/^[+-]?\d+$/.test(raw.trim())) invalid();
  const days = Number(raw);
  if (!ALLOWED_DAYS.includes(days)) invalid();
  return days;
}

function optionalInt(c: Context<AppEnv>, name: string): number | null {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return null;
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) invalid();
  return Number(raw);
}

// ---------------------------------------------------------------------------
// Queries (one region)
// ---------------------------------------------------------------------------
// Every figure is counted, summed or grouped in SQL; only small grouped results (per book,
// per school, per status) and the narrow row sets the time-zone bucketing needs come back.

/** `col >= start`, or no condition for all time. */
const inWindow = (col: SQLWrapper, start: string | null): SQL | undefined => (start ? gte(col, start) : undefined);

/** Users holding an active verification in the region (not deleted), created in the window. */
async function regionUsers(db: Database, code: string, start: string | null = null) {
  return db
    .selectDistinct({ id: users.id, createdAt: users.createdAt })
    .from(users)
    .innerJoin(regionVerifications, eq(regionVerifications.userId, users.id))
    .where(
      and(
        eq(regionVerifications.regionCode, code),
        eq(regionVerifications.isActive, 1),
        sql`${users.deletedAt} IS NULL`,
        inWindow(users.createdAt, start),
      ),
    );
}

/** One book's figures over the window's orders (the null group is orders whose listing is gone). */
interface OrderGroup {
  order_count: number;
  completed_count: number;
  cancelled_count: number;
  gmv: number;
  min_price: number | null;
  max_price: number | null;
}

/** The region's orders in the window, grouped on the listing's book; `listingCond` narrows by the listing. */
async function orderGroups(db: Database, code: string, start: string | null, listingCond?: SQL): Promise<Map<string | null, OrderGroup>> {
  const completed = sql`${orders.status} = 'completed'`;
  const rows = await db
    .select({
      bookId: listings.bookId,
      orderCount: sql<number>`count(*)`,
      completedCount: sql<number>`coalesce(sum(${completed}), 0)`,
      cancelledCount: sql<number>`coalesce(sum(${orders.status} = 'cancelled'), 0)`,
      gmv: sql<number>`coalesce(sum(CASE WHEN ${completed} THEN ${orders.totalAmount} END), 0)`,
      minPrice: sql<number | null>`min(CASE WHEN ${completed} THEN ${orders.totalAmount} END)`,
      maxPrice: sql<number | null>`max(CASE WHEN ${completed} THEN ${orders.totalAmount} END)`,
    })
    .from(orders)
    .leftJoin(listings, eq(listings.id, orders.listingId))
    .where(and(eq(orders.regionCode, code), inWindow(orders.createdAt, start), listingCond))
    .groupBy(listings.bookId);
  return new Map(
    rows.map((r) => [
      r.bookId,
      {
        order_count: r.orderCount,
        completed_count: r.completedCount,
        cancelled_count: r.cancelledCount,
        gmv: r.gmv,
        min_price: r.minPrice,
        max_price: r.maxPrice,
      },
    ]),
  );
}

/** Active listings per book in the region; `cond` narrows by the listing. */
async function activeListingCounts(db: Database, code: string, cond?: SQL): Promise<Map<string, number>> {
  const rows = await db
    .select({ bookId: listings.bookId, n: count() })
    .from(listings)
    .where(and(eq(listings.regionCode, code), eq(listings.status, 'active'), cond))
    .groupBy(listings.bookId);
  return new Map(rows.map((r) => [r.bookId, r.n]));
}

/** Completed orders per school of the listing (window), as top-school groups. */
async function completedBySchool(
  db: Database,
  code: string,
  start: string | null,
  extra?: SQL,
): Promise<{ schoolId: number; n: number; gmv: number }[]> {
  const rows = await db
    .select({ schoolId: listings.schoolId, n: count(), gmv: sql<number>`coalesce(sum(${orders.totalAmount}), 0)` })
    .from(orders)
    .innerJoin(listings, eq(listings.id, orders.listingId))
    .where(
      and(
        eq(orders.regionCode, code),
        eq(orders.status, 'completed'),
        isNotNull(listings.schoolId),
        inWindow(orders.createdAt, start),
        extra,
      ),
    )
    .groupBy(listings.schoolId);
  return rows.map((r) => ({ schoolId: r.schoolId as number, n: r.n, gmv: r.gmv }));
}

/** `{status: n}` for the region's orders in the window (every known status present), plus the extra statuses found. */
async function orderStatusCounts(db: Database, code: string, start: string | null, extra?: SQL): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  const rows = await db
    .select({ status: orders.status, n: count() })
    .from(orders)
    .leftJoin(listings, eq(listings.id, orders.listingId))
    .where(and(eq(orders.regionCode, code), inWindow(orders.createdAt, start), extra))
    .groupBy(orders.status);
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + r.n;
  return out;
}

async function loadBooks(db: Database, ids: Iterable<string>): Promise<Map<string, Book>> {
  const list = [...new Set(ids)];
  const out = new Map<string, Book>();
  for (let i = 0; i < list.length; i += 90) {
    for (const b of await db
      .select()
      .from(books)
      .where(inArray(books.id, list.slice(i, i + 90))))
      out.set(b.id, b);
  }
  return out;
}

async function loadSchools(db: Database, ids: Iterable<number>) {
  const list = [...new Set(ids)];
  const out = new Map<number, typeof schools.$inferSelect>();
  for (let i = 0; i < list.length; i += 90) {
    for (const s of await db
      .select()
      .from(schools)
      .where(inArray(schools.id, list.slice(i, i + 90))))
      out.set(s.id, s);
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** What the day/hour series needs of an order. */
interface SeriesOrder {
  status: string;
  totalAmount: number;
  createdAt: string;
}

function orderSeries(buckets: SeriesBuckets, rows: SeriesOrder[], withGmv = true) {
  const all = buckets.group(rows, (o) => o.createdAt);
  const done = rows.filter((o) => o.status === 'completed');
  const completed = buckets.group(done, (o) => o.createdAt);
  const gmv = buckets.group(
    done,
    (o) => o.createdAt,
    (o) => o.totalAmount,
  );
  return buckets.labels.map((label) => {
    const item: Record<string, unknown> = { date: label, orders: all.get(label) ?? 0, completed: completed.get(label) ?? 0 };
    if (withGmv) item.gmv = gmv.get(label) ?? 0;
    return item;
  });
}

async function topSchools(
  db: Database,
  groups: { schoolId: number; n: number; gmv: number }[],
  lang: string | null,
  withGmv = true,
  limit = 10,
) {
  const top = [...groups].sort((a, b) => b.n - a.n || b.gmv - a.gmv || a.schoolId - b.schoolId).slice(0, limit);
  const found = await loadSchools(
    db,
    top.map((g) => g.schoolId),
  );
  return top.map((g) => {
    const s = found.get(g.schoolId);
    const item: Record<string, unknown> = {
      id: g.schoolId,
      code: s ? s.code : '',
      name: s ? (lang ? localized(s.translations, lang, 'name', s.name) : s.name) : '',
      completed_orders: g.n,
    };
    if (withGmv) item.gmv = g.gmv;
    return item;
  });
}

function bookDict(b: Book, full = false) {
  const data: Record<string, unknown> = { id: b.id, title: b.title, authors: b.authors, isbn13: b.isbn13, cover_url: b.coverUrl };
  if (full) {
    data.publisher = b.publisher;
    data.published_date = b.publishedDate;
    data.source = b.source;
  }
  return data;
}

interface BookStats {
  order_count: number;
  completed_count: number;
  cancelled_count: number;
  gmv: number;
  avg_price: number | null;
  min_price: number | null;
  max_price: number | null;
  active_listings: number;
}

const emptyStats = (): BookStats => ({
  order_count: 0,
  completed_count: 0,
  cancelled_count: 0,
  gmv: 0,
  avg_price: null,
  min_price: null,
  max_price: null,
  active_listings: 0,
});

/** Per-book transaction figures over the grouped orders (already scoped) and the region's active listings per book. */
function bookStats(groups: Map<string | null, OrderGroup>, activeListings: Map<string, number>): Map<string, BookStats> {
  const out = new Map<string, BookStats>();
  for (const [id, g] of groups) {
    if (!id) continue;
    out.set(id, {
      order_count: g.order_count,
      completed_count: g.completed_count,
      cancelled_count: g.cancelled_count,
      gmv: g.gmv,
      avg_price: g.completed_count ? roundInt(g.gmv / g.completed_count) : null,
      min_price: g.min_price,
      max_price: g.max_price,
      active_listings: 0,
    });
  }
  for (const [id, n] of activeListings) {
    const s = out.get(id) ?? emptyStats();
    s.active_listings = n;
    out.set(id, s);
  }
  return out;
}

/** Books ranked by a figure over the period's orders (grouped on the listing's book, a deleted one included). */
function bookRanker(groups: Map<string | null, OrderGroup>, field: SortField): CompetitionRank {
  return new CompetitionRank([...groups.values()].map((g) => g[field]));
}

const TEXT_FIELDS = { course: 'courseName', professor: 'professorName' } as const;
const textKey = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/**
 * The listing condition for ?school= ?category= ?course= ?professor=, or null when none is given.
 * Course and professor match on their trimmed, lower-cased text, so the stored spellings that
 * match are looked up first and the query then filters on those exact values.
 */
async function listingScope(c: Context<AppEnv>, db: Database, code: string): Promise<SQL | null> {
  const conds: SQL[] = [eq(listings.regionCode, code)];
  let scoped = false;
  for (const name of ['school', 'category'] as const) {
    const raw = c.req.query(name);
    if (raw === undefined || raw === '') continue;
    scoped = true;
    const col = name === 'school' ? listings.schoolId : listings.categoryId;
    if (raw === 'none') {
      conds.push(isNull(col));
      continue;
    }
    if (!/^\s*[+-]?\d+\s*$/.test(raw)) invalid();
    conds.push(eq(col, Number(raw)));
  }
  for (const [name, field] of Object.entries(TEXT_FIELDS)) {
    const raw = c.req.query(name);
    if (!raw) continue;
    scoped = true;
    const col = listings[field];
    const stored = await db.selectDistinct({ v: col }).from(listings).where(eq(listings.regionCode, code));
    const matching = stored.map((s) => s.v).filter((v) => textKey(v) === raw);
    conds.push(matching.length ? inArray(col, matching) : sql`0`);
  }
  return scoped ? and(...conds)! : null;
}

/** Request totals for the region: all-time figures, plus those created in the window. */
async function requestSummary(db: Database, code: string, start: string | null) {
  const [row] = await db
    .select({
      total: count(),
      fresh: start ? sql<number>`coalesce(sum(${subscriptions.createdAt} >= ${start}), 0)` : count(),
      requestedBooks: sql<number>`count(DISTINCT ${subscriptions.bookId})`,
      unlistedBooks: sql<number>`count(DISTINCT CASE WHEN subscriptions.book_id NOT IN (SELECT l.book_id FROM listings l WHERE l.region_code = ${code} AND l.status = 'active') THEN subscriptions.book_id END)`,
    })
    .from(subscriptions)
    .where(eq(subscriptions.regionCode, code));
  return { total: row.total, new: row.fresh, requested_books: row.requestedBooks, unlisted_books: row.unlistedBooks };
}

interface RequestStats {
  request_count: number;
  new_requests: number;
  notified_count: number;
  waiting_count: number;
  active_listings: number;
  last_requested_at: string | null;
}

/** Per requested book: how many asked, how many in the window, how many were told, and the region's active listings of it. */
async function requestStats(db: Database, code: string, start: string | null): Promise<Map<string, RequestStats>> {
  const rows = await db
    .select({
      bookId: subscriptions.bookId,
      requests: count(),
      fresh: start ? sql<number>`coalesce(sum(${subscriptions.createdAt} >= ${start}), 0)` : count(),
      notified: sql<number>`coalesce(sum(${subscriptions.notifiedAt} IS NOT NULL AND ${subscriptions.notifiedAt} <> ''), 0)`,
      last: sql<string>`max(${subscriptions.createdAt})`,
    })
    .from(subscriptions)
    .where(eq(subscriptions.regionCode, code))
    .groupBy(subscriptions.bookId);
  const active = await activeListingCounts(db, code);
  return new Map(
    rows.map((r) => [
      r.bookId,
      {
        request_count: r.requests,
        new_requests: r.fresh,
        notified_count: r.notified,
        waiting_count: r.requests - r.notified,
        active_listings: active.get(r.bookId) ?? 0,
        last_requested_at: r.last,
      },
    ]),
  );
}

function requestRanker(stats: Map<string, RequestStats>, unlistedOnly = false): CompetitionRank {
  return new CompetitionRank([...stats.values()].filter((s) => !unlistedOnly || s.active_listings === 0).map((s) => s.request_count));
}

function bookTextMatch(b: Book, q: string): boolean {
  const isbn = q.replace(/[- ]/g, '');
  const lq = q.toLowerCase();
  return (
    b.title.toLowerCase().includes(lq) ||
    b.authors.toLowerCase().includes(lq) ||
    (!!b.isbn13 && b.isbn13.toLowerCase().includes(isbn.toLowerCase()))
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** Reports of one table: how many are open, how many are new, and the new ones per reason. */
function reportTotals(rows: { status: string; reason: string; n: number; fresh: number }[]) {
  const reasons = new Map<string, number>();
  let open = 0;
  let fresh = 0;
  for (const r of rows) {
    if (r.status === 'open') open += r.n;
    fresh += r.fresh;
    if (r.fresh > 0) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.fresh);
  }
  return { open, fresh, reasons };
}

statsRoutes.get('/stats/overview', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const lang = await resolveLanguage(c);
  const start = periodStart(region.tz, days);
  const code = region.code;
  const freshReports = (col: SQLWrapper) => (start ? sql<number>`coalesce(sum(${col} >= ${start}), 0)` : count());

  const periodOrders = and(eq(orders.regionCode, code), inWindow(orders.createdAt, start));
  const [
    byStatus,
    completedTotals,
    completedTimes,
    cancelGroups,
    buyers,
    schoolGroups,
    listingStatusRows,
    activePrices,
    periodListings,
    reqSummary,
    userTotals,
    listingReportRows,
    chatReportRows,
    reviewTotals,
  ] = await Promise.all([
    orderStatusCounts(db, code, start),
    db
      .select({ gmv: sql<number>`coalesce(sum(${orders.totalAmount}), 0)` })
      .from(orders)
      .where(and(periodOrders, eq(orders.status, 'completed'))),
    db
      .select({ createdAt: orders.createdAt, completedAt: orders.completedAt })
      .from(orders)
      .where(and(periodOrders, eq(orders.status, 'completed'), isNotNull(orders.completedAt))),
    db
      .select({ reason: sql<string>`coalesce(${orders.cancelReason}, '')`, count: count() })
      .from(orders)
      .where(and(periodOrders, eq(orders.status, 'cancelled')))
      .groupBy(sql`coalesce(${orders.cancelReason}, '')`),
    db
      .select({ n: sql<number>`count(DISTINCT ${orders.buyerId})` })
      .from(orders)
      .where(periodOrders),
    completedBySchool(db, code, start),
    db.select({ status: listings.status, n: count() }).from(listings).where(eq(listings.regionCode, code)).groupBy(listings.status),
    db
      .select({ n: count(), total: sql<number>`coalesce(sum(${listings.price}), 0)` })
      .from(listings)
      .where(and(eq(listings.regionCode, code), eq(listings.status, 'active'))),
    db
      .select({ n: count(), sellers: sql<number>`count(DISTINCT ${listings.sellerId})` })
      .from(listings)
      .where(and(eq(listings.regionCode, code), inWindow(listings.createdAt, start))),
    requestSummary(db, code, start),
    db
      .select({
        total: sql<number>`count(DISTINCT ${users.id})`,
        fresh: start
          ? sql<number>`count(DISTINCT CASE WHEN ${users.createdAt} >= ${start} THEN ${users.id} END)`
          : sql<number>`count(DISTINCT ${users.id})`,
      })
      .from(users)
      .innerJoin(regionVerifications, eq(regionVerifications.userId, users.id))
      .where(and(eq(regionVerifications.regionCode, code), eq(regionVerifications.isActive, 1), sql`${users.deletedAt} IS NULL`)),
    db
      .select({ status: reports.status, reason: reports.reason, n: count(), fresh: freshReports(reports.createdAt) })
      .from(reports)
      .where(eq(reports.regionCode, code))
      .groupBy(reports.status, reports.reason),
    db
      .select({ status: chatReports.status, reason: chatReports.reason, n: count(), fresh: freshReports(chatReports.createdAt) })
      .from(chatReports)
      .innerJoin(conversations, eq(conversations.id, chatReports.conversationId))
      .where(eq(conversations.regionCode, code))
      .groupBy(chatReports.status, chatReports.reason),
    db
      .select({
        count: count(),
        noShows: sql<number>`coalesce(sum(${reviews.isNoShow} <> 0), 0)`,
        rated: sql<number>`coalesce(sum(${reviews.isNoShow} = 0 AND ${reviews.rating} IS NOT NULL), 0)`,
        ratingSum: sql<number>`coalesce(sum(CASE WHEN ${reviews.isNoShow} = 0 THEN ${reviews.rating} END), 0)`,
      })
      .from(reviews)
      .innerJoin(orders, eq(orders.id, reviews.orderId))
      .where(and(eq(orders.regionCode, code), inWindow(reviews.createdAt, start))),
  ]);

  const completedCount = byStatus.completed;
  const gmv = completedTotals[0].gmv;
  const durations = completedTimes.map((o) => (Date.parse(o.completedAt!) - Date.parse(o.createdAt)) / 1000);
  const avgDuration = avg(durations);
  const done = byStatus.completed + byStatus.cancelled;
  const cancelReasons = cancelGroups
    .map((g) => ({ reason: String(g.reason), count: g.count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  const listingStatus: Record<string, number> = Object.fromEntries(LISTING_STATUSES.map((s) => [s, 0]));
  for (const r of listingStatusRows) listingStatus[r.status] = (listingStatus[r.status] ?? 0) + r.n;

  // Moderation
  const listingReports = reportTotals(listingReportRows);
  const chatReportTotals = reportTotals(chatReportRows);
  const reasons = new Map<string, number>();
  for (const [reason, n] of [...listingReports.reasons, ...chatReportTotals.reasons]) reasons.set(reason, (reasons.get(reason) ?? 0) + n);

  // Reviews on this region's orders
  const reviewStats = reviewTotals[0];
  const avgRating = reviewStats.rated ? reviewStats.ratingSum / reviewStats.rated : null;

  // Ads shown in this region (ads DB); views / clicks recorded here during
  // the period, from Analytics Engine (0, stats_available false, when the
  // SQL API is not configured).
  const now = new Date().toISOString();
  const adRows = await createAdsDb(c.env.DB_ADS)
    .select({
      isActive: ads.isActive,
      startDate: ads.startDate,
      endDate: ads.endDate,
      advActive: advertisers.isActive,
    })
    .from(ads)
    .innerJoin(advertisers, eq(advertisers.id, ads.advertiserId))
    .where(
      sql`(${advertisers.allRegions} = 1 OR EXISTS (SELECT 1 FROM ${advertiserRegions} ar WHERE ar.advertiser_id = ${advertisers.id} AND ar.region_code = ${code}))`,
    );
  const adTotals = await regionAdTotals(c.env, code, start);
  const adViews = adTotals.views;
  const adClicks = adTotals.clicks;

  const [{ n: conversationCount }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(conversations)
    .where(eq(conversations.regionCode, code));

  const newOrders = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return c.json({
    region: code,
    currency: region.defaultCurrency,
    days,
    since: start,
    users: {
      total: userTotals[0].total,
      new: userTotals[0].fresh,
      active_sellers: periodListings[0].sellers,
      active_buyers: buyers[0].n,
    },
    listings: {
      new: periodListings[0].n,
      by_status: listingStatus,
      avg_price: roundInt(activePrices[0].n ? activePrices[0].total / activePrices[0].n : null),
    },
    orders: {
      new: newOrders,
      by_status: byStatus,
      completion_rate: ratio(byStatus.completed, done),
      cancel_rate: ratio(byStatus.cancelled, done),
      gmv,
      avg_order_value: roundInt(completedCount ? gmv / completedCount : null),
      avg_days_to_complete: avgDuration === null ? null : roundHalfEven(avgDuration / DAY_SECONDS, 1),
      cancel_reasons: cancelReasons,
    },
    engagement: { conversations: conversationCount },
    requests: reqSummary,
    moderation: {
      open_listing_reports: listingReports.open,
      open_chat_reports: chatReportTotals.open,
      new_listing_reports: listingReports.fresh,
      new_chat_reports: chatReportTotals.fresh,
      report_reasons: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    },
    reviews: {
      count: reviewStats.count,
      avg_rating: avgRating === null ? null : roundHalfEven(avgRating, 2),
      no_show_count: reviewStats.noShows,
    },
    ads: {
      active: adRows.filter((a) => a.isActive && a.advActive && a.startDate <= now && a.endDate >= now).length,
      views: adViews,
      clicks: adClicks,
      ctr: ratio(adClicks, adViews),
      stats_available: adTotals.available,
    },
    top_schools: await topSchools(db, schoolGroups, lang),
  });
});

// ---------------------------------------------------------------------------
// Timeseries
// ---------------------------------------------------------------------------

statsRoutes.get('/stats/timeseries', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const buckets = new SeriesBuckets(region.tz, days);
  const [orderRows, listingRows, regUsers] = await Promise.all([
    db
      .select({ status: orders.status, totalAmount: orders.totalAmount, createdAt: orders.createdAt })
      .from(orders)
      .where(and(eq(orders.regionCode, region.code), gte(orders.createdAt, buckets.start))),
    db
      .select({ createdAt: listings.createdAt })
      .from(listings)
      .where(and(eq(listings.regionCode, region.code), gte(listings.createdAt, buckets.start))),
    regionUsers(db, region.code, buckets.start),
  ]);
  const series = orderSeries(buckets, orderRows);
  const newUsers = buckets.group(regUsers, (u) => u.createdAt);
  const newListings = buckets.group(listingRows, (l) => l.createdAt);
  buckets.labels.forEach((label, i) => {
    series[i].new_users = newUsers.get(label) ?? 0;
    series[i].new_listings = newListings.get(label) ?? 0;
  });
  return c.json({ region: region.code, currency: region.defaultCurrency, days, unit: buckets.unit, series });
});

// ---------------------------------------------------------------------------
// Book ranking
// ---------------------------------------------------------------------------

statsRoutes.get('/stats/books/ranking', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const sort = c.req.query('sort') || 'completed';
  if (!(sort in SORT_FIELDS)) invalid();
  const sortField = SORT_FIELDS[sort as keyof typeof SORT_FIELDS];
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const q = (c.req.query('q') ?? '').trim();
  const start = periodStart(region.tz, days);

  const scope = await listingScope(c, db, region.code);
  const [groups, activeCounts] = await Promise.all([
    orderGroups(db, region.code, start, scope ?? undefined),
    activeListingCounts(db, region.code, scope ?? undefined),
  ]);
  const stats = bookStats(groups, activeCounts);

  let candidates: Book[];
  if (q) {
    const isbn = q.replace(/[- ]/g, '');
    const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const isbnPattern = `%${isbn.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    candidates = await db
      .select()
      .from(books)
      .where(
        and(
          sql`(lower(${books.title}) LIKE ${pattern} ESCAPE '\\' OR lower(${books.authors}) LIKE ${pattern} ESCAPE '\\' OR ${books.isbn13} LIKE ${isbnPattern} ESCAPE '\\')`,
          // This region's books, and any book listed here.
          or(
            eq(books.regionCode, region.code),
            inArray(books.id, db.select({ id: listings.bookId }).from(listings).where(eq(listings.regionCode, region.code))),
          ),
        ),
      );
  } else {
    candidates = [
      ...(
        await loadBooks(
          db,
          [...groups.keys()].filter((id): id is string => !!id),
        )
      ).values(),
    ];
  }
  const rows = candidates.map((b) => ({ b, s: stats.get(b.id) ?? emptyStats() }));
  rows.sort(
    (x, y) =>
      y.s[sortField] - x.s[sortField] ||
      y.s.completed_count - x.s.completed_count ||
      y.s.gmv - x.s.gmv ||
      (x.b.title < y.b.title ? -1 : x.b.title > y.b.title ? 1 : 0) ||
      (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0),
  );
  const ranker = bookRanker(groups, sortField);
  const results = rows.slice(page.offset, page.offset + page.limit).map(({ b, s }) => ({
    rank: ranker.rank(s[sortField]),
    book: bookDict(b),
    ...s,
  }));
  return c.json({ ...page.wrap(results, rows.length), currency: region.defaultCurrency, sort });
});

// ---------------------------------------------------------------------------
// Book requests
// ---------------------------------------------------------------------------

statsRoutes.get('/stats/books/requests', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const unlistedOnly = ['1', 'true'].includes((c.req.query('unlisted') ?? '').toLowerCase());
  const q = (c.req.query('q') ?? '').trim();
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const start = periodStart(region.tz, days);

  const [stats, summary] = await Promise.all([requestStats(db, region.code, start), requestSummary(db, region.code, start)]);
  const bookMap = await loadBooks(db, stats.keys());
  let rows = [...stats.entries()].flatMap(([id, s]) => {
    const b = bookMap.get(id);
    return b ? [{ b, s }] : [];
  });
  if (unlistedOnly) rows = rows.filter((r) => r.s.active_listings === 0);
  if (q) rows = rows.filter((r) => bookTextMatch(r.b, q));
  rows.sort(
    (x, y) =>
      y.s.request_count - x.s.request_count ||
      y.s.new_requests - x.s.new_requests ||
      (x.b.title < y.b.title ? -1 : x.b.title > y.b.title ? 1 : 0) ||
      (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0),
  );
  const ranker = requestRanker(stats, unlistedOnly);
  const results = rows.slice(page.offset, page.offset + page.limit).map(({ b, s }) => ({
    rank: ranker.rank(s.request_count),
    book: bookDict(b),
    ...s,
  }));
  return c.json({ ...page.wrap(results, rows.length), summary });
});

// ---------------------------------------------------------------------------
// Breakdown by school / category / course / professor
// ---------------------------------------------------------------------------

const BREAKDOWN_DIMENSIONS = ['school', 'category', 'course', 'professor'] as const;
const BREAKDOWN_SORTS = ['completed', 'gmv', 'orders', 'new_listings', 'active_listings'] as const;

statsRoutes.get('/stats/breakdown', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const lang = await resolveLanguage(c);
  const start = periodStart(region.tz, days);
  const by = (c.req.query('by') || 'school') as (typeof BREAKDOWN_DIMENSIONS)[number];
  const sort = (c.req.query('sort') || 'completed') as (typeof BREAKDOWN_SORTS)[number];
  if (!BREAKDOWN_DIMENSIONS.includes(by) || !BREAKDOWN_SORTS.includes(sort)) invalid();
  const school = by !== 'school' ? optionalInt(c, 'school') : null;
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const pageNo = Math.max(1, optionalInt(c, 'page') || 1);
  const pageSize = Math.min(100, Math.max(1, optionalInt(c, 'page_size') || 20));

  const textCol = by === 'course' ? 'courseName' : by === 'professor' ? 'professorName' : null;
  const fkCol = by === 'school' ? 'schoolId' : 'categoryId';
  // The grouping column: the listing's foreign key, or its raw text (folded by textKey below).
  const groupCol = textCol ? listings[textCol] : listings[fkCol];

  interface Row {
    key: string | number | null;
    label: string;
    active_listings: number;
    new_listings: number;
    orders: number;
    completed: number;
    gmv: number;
    rank?: number | null;
    id?: string | number | null;
    keywords?: string[];
    _search?: string;
  }
  const rows = new Map<string | number | null, Row>();

  // Listings (all-time) per group: active, created in the window, and how many in all.
  const listingGroups = await db
    .select({
      key: groupCol,
      active: sql<number>`coalesce(sum(${listings.status} = 'active'), 0)`,
      fresh: start ? sql<number>`coalesce(sum(${listings.createdAt} >= ${start}), 0)` : count(),
      total: count(),
    })
    .from(listings)
    .where(and(eq(listings.regionCode, region.code), school ? eq(listings.schoolId, school) : undefined))
    .groupBy(groupCol)
    .orderBy(sql`min(${listings}.rowid)`);
  const labelOf = new Map<string | number | null, string>();
  let listingTotal = 0;
  let listingsWithValue = 0;
  for (const g of listingGroups) {
    listingTotal += g.total;
    if (typeof g.key === 'string' && g.key.trim() !== '') listingsWithValue += g.total;
    const k = textCol ? textKey(g.key as string | null) : (g.key as number | null);
    if (textCol && !k) continue;
    const r = rows.get(k) ?? { key: k, label: '', active_listings: 0, new_listings: 0, orders: 0, completed: 0, gmv: 0 };
    r.active_listings += g.active;
    r.new_listings += g.fresh;
    rows.set(k, r);
    if (textCol) {
      // The shortest-sorting trimmed spelling names the group.
      const spelled = ((g.key as string | null) ?? '').trim();
      const seen = labelOf.get(k);
      if (seen === undefined || spelled < seen) labelOf.set(k, spelled);
    }
  }
  if (textCol) {
    for (const [k, label] of labelOf) rows.get(k)!.label = label;
  }

  // Orders in the window land on their listing's group; one whose listing is gone has no
  // key, which the join yields as NULL and a foreign key shows as the "none" row.
  const orderGroupsByKey = await db
    .select({
      key: groupCol,
      orders: count(),
      completed: sql<number>`coalesce(sum(${orders.status} = 'completed'), 0)`,
      gmv: sql<number>`coalesce(sum(CASE WHEN ${orders.status} = 'completed' THEN ${orders.totalAmount} END), 0)`,
    })
    .from(orders)
    .leftJoin(listings, eq(listings.id, orders.listingId))
    .where(and(eq(orders.regionCode, region.code), inWindow(orders.createdAt, start), school ? eq(listings.schoolId, school) : undefined))
    .groupBy(groupCol);
  for (const g of orderGroupsByKey) {
    const r = rows.get(textCol ? textKey(g.key as string | null) : ((g.key as number | null) ?? null));
    if (!r) continue;
    r.orders += g.orders;
    r.completed += g.completed;
    r.gmv += g.gmv;
  }
  let list = [...rows.values()].filter((r) => r.active_listings || r.new_listings || r.orders);

  // Labels and search text.
  const keys = list.map((r) => r.key).filter((k): k is number => typeof k === 'number');
  if (by === 'school') {
    const found = await loadSchools(db, keys);
    for (const r of list) {
      const s = typeof r.key === 'number' ? found.get(r.key) : undefined;
      const allNames = s
        ? [
            s.name,
            ...Object.values(parseJsonObject(s.translations)).flatMap((t) =>
              t && typeof t === 'object' && typeof (t as Record<string, unknown>).name === 'string'
                ? [(t as Record<string, string>).name]
                : [],
            ),
          ]
        : [];
      const keywords = s ? [...new Set(allNames.filter(Boolean)), s.code] : [];
      r.keywords = keywords;
      r.label = s ? (lang ? localized(s.translations, lang, 'name', s.name) : s.name) : '';
      r._search = `${r.label} ${keywords.join(' ')}`.toLowerCase();
    }
  } else if (by === 'category') {
    const found = new Map<number, typeof categories.$inferSelect>();
    for (let i = 0; i < keys.length; i += 90) {
      for (const cat of await db
        .select()
        .from(categories)
        .where(inArray(categories.id, keys.slice(i, i + 90))))
        found.set(cat.id, cat);
    }
    for (const r of list) {
      const cat = typeof r.key === 'number' ? found.get(r.key) : undefined;
      r.label = cat ? (lang ? localized(cat.translations, lang, 'title', cat.title) : cat.title) : '';
      r._search = `${r.label} ${cat ? cat.title : ''}`.toLowerCase();
    }
  } else {
    for (const r of list) r._search = `${r.label} `.toLowerCase();
  }

  const ranker = new CompetitionRank(list.map((r) => r[sort]));
  for (const r of list) {
    r.rank = ranker.rank(r[sort]);
    if (!textCol) {
      r.id = r.key;
      delete (r as Partial<Row>).key;
    }
  }
  if (q) list = list.filter((r) => (r._search ?? '').includes(q));
  for (const r of list) delete r._search;
  list.sort(
    (a, b) =>
      b[sort] - a[sort] ||
      b.completed - a.completed ||
      b.new_listings - a.new_listings ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );

  const summary: Record<string, number> = { groups: list.length };
  if (textCol) {
    summary.listings = listingTotal;
    summary.listings_with_value = listingsWithValue;
  }
  const from = (pageNo - 1) * pageSize;
  return c.json({
    region: region.code,
    currency: region.defaultCurrency,
    days,
    by,
    sort,
    count: list.length,
    summary,
    results: list.slice(from, from + pageSize),
  });
});

// ---------------------------------------------------------------------------
// One book
// ---------------------------------------------------------------------------

statsRoutes.get('/stats/books/:id', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const lang = await resolveLanguage(c);
  const start = periodStart(region.tz, days);
  const id = uuidId(c.req.param('id'));
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, id), eq(books.regionCode, region.code)))
    .limit(1);
  if (!book) notFound();

  const buckets = new SeriesBuckets(region.tz, days);
  const thisBook = and(eq(orders.regionCode, region.code), eq(listings.bookId, book.id));
  const [groups, activeCounts, reqStatsAll, byStatus, allTime, recent, bookActive, seriesOrders, schoolGroups] = await Promise.all([
    orderGroups(db, region.code, start),
    activeListingCounts(db, region.code),
    requestStats(db, region.code, start),
    orderStatusCounts(db, region.code, start, eq(listings.bookId, book.id)),
    db
      .select({ n: count() })
      .from(orders)
      .innerJoin(listings, eq(listings.id, orders.listingId))
      .where(and(thisBook, eq(orders.status, 'completed'))),
    db
      .select({
        id: orders.id,
        status: orders.status,
        totalAmount: orders.totalAmount,
        createdAt: orders.createdAt,
        schoolId: listings.schoolId,
      })
      .from(orders)
      .innerJoin(listings, eq(listings.id, orders.listingId))
      .where(thisBook)
      .orderBy(desc(orders.createdAt), sql`${orders}.rowid`)
      .limit(10),
    db
      .select({
        id: listings.id,
        price: listings.price,
        condition: listings.condition,
        createdAt: listings.createdAt,
        schoolId: listings.schoolId,
      })
      .from(listings)
      .where(and(eq(listings.regionCode, region.code), eq(listings.status, 'active'), eq(listings.bookId, book.id)))
      .orderBy(asc(listings.price), desc(listings.createdAt), sql`${listings}.rowid`)
      .limit(20),
    db
      .select({ status: orders.status, totalAmount: orders.totalAmount, createdAt: orders.createdAt })
      .from(orders)
      .innerJoin(listings, eq(listings.id, orders.listingId))
      .where(and(thisBook, gte(orders.createdAt, buckets.start))),
    completedBySchool(db, region.code, start, eq(listings.bookId, book.id)),
  ]);
  const stats = bookStats(groups, activeCounts).get(book.id) ?? emptyStats();

  const summary = {
    ...stats,
    all_time_completed: allTime[0].n,
    rank: bookRanker(groups, 'completed_count').rank(stats.completed_count),
  };

  const schoolMap = await loadSchools(
    db,
    [...recent, ...bookActive].flatMap((x) => (x.schoolId !== null ? [x.schoolId] : [])),
  );
  const schoolName = (sid: number | null) => {
    const s = sid !== null ? schoolMap.get(sid) : undefined;
    return s ? (lang ? localized(s.translations, lang, 'name', s.name) : s.name) : '';
  };

  const mine = reqStatsAll.get(book.id) ?? {
    request_count: 0,
    new_requests: 0,
    notified_count: 0,
    waiting_count: 0,
    active_listings: 0,
    last_requested_at: null,
  };
  const { active_listings: _omit, ...requests } = mine;

  return c.json({
    region: region.code,
    currency: region.defaultCurrency,
    days,
    book: bookDict(book, true),
    summary,
    requests: { ...requests, rank: requestRanker(reqStatsAll).rank(mine.request_count) },
    by_status: byStatus,
    series_unit: buckets.unit,
    series: orderSeries(buckets, seriesOrders, false),
    top_schools: await topSchools(db, schoolGroups, lang, false),
    recent_orders: recent.map((o) => ({
      id: o.id,
      status: o.status,
      total_amount: o.totalAmount,
      school_name: schoolName(o.schoolId),
      created_at: o.createdAt,
    })),
    active_listings: bookActive.map((l) => ({
      id: l.id,
      price: l.price,
      condition: l.condition,
      school_name: schoolName(l.schoolId),
      created_at: l.createdAt,
    })),
  });
});

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

function durations(pairs: [string | null | undefined, string | null | undefined][]) {
  const daysList = pairs.flatMap(([a, b]) => {
    if (!a || !b) return [];
    const d = (Date.parse(b) - Date.parse(a)) / 1000;
    return d >= 0 ? [d / DAY_SECONDS] : [];
  });
  if (!daysList.length) return { count: 0, avg_days: null, median_days: null };
  return {
    count: daysList.length,
    avg_days: roundHalfEven(sum(daysList) / daysList.length, 1),
    median_days: roundHalfEven(median(daysList), 1),
  };
}

statsRoutes.get('/stats/growth', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const start = periodStart(region.tz, days);
  const code = region.code;

  const periodListingCond = and(eq(listings.regionCode, code), inWindow(listings.createdAt, start));
  const periodOrderCond = and(eq(orders.regionCode, code), inWindow(orders.createdAt, start));
  const windowListingIds = db.select({ id: listings.id }).from(listings).where(periodListingCond);
  // Correlated subqueries name their tables outright: the query builder drops table qualifiers from a
  // join-free statement, which would bind the inner columns to themselves.
  // A chat and an order are the same pair when they name the same listing (kept by its ref once deleted) and buyer.
  const chatOrder = (completed: boolean) =>
    sql`EXISTS (SELECT 1 FROM orders o WHERE o.region_code = ${code} AND coalesce(o.listing_ref, o.listing_id) IS coalesce(conversations.listing_ref, conversations.listing_id) AND o.buyer_id = conversations.buyer_id AND (${completed ? 1 : 0} = 0 OR o.status = 'completed'))`;
  const requestOrder = (completed: boolean) =>
    sql`EXISTS (SELECT 1 FROM orders o INNER JOIN listings l ON l.id = o.listing_id WHERE o.region_code = ${code} AND o.buyer_id = subscriptions.user_id AND l.book_id = subscriptions.book_id AND o.created_at >= subscriptions.created_at AND (${completed ? 1 : 0} = 0 OR o.status = 'completed'))`;

  const [periodListings, firstChat, firstOrder, sales, buyerRows, orderSellers, listingSellers, chatTotals, requestTotals] =
    await Promise.all([
      db
        .select({ id: listings.id, createdAt: listings.createdAt, sellerId: listings.sellerId, status: listings.status })
        .from(listings)
        .where(periodListingCond),
      // Liquidity: first chat / first order per listing.
      db
        .select({ listingId: conversations.listingId, at: sql<string>`min(${conversations.createdAt})` })
        .from(conversations)
        .where(and(eq(conversations.regionCode, code), inArray(conversations.listingId, windowListingIds)))
        .groupBy(conversations.listingId),
      db
        .select({ listingId: orders.listingId, at: sql<string>`min(${orders.createdAt})` })
        .from(orders)
        .where(and(eq(orders.regionCode, code), inArray(orders.listingId, windowListingIds)))
        .groupBy(orders.listingId),
      db
        .select({ createdAt: orders.createdAt, completedAt: orders.completedAt, listingCreatedAt: listings.createdAt })
        .from(orders)
        .leftJoin(listings, eq(listings.id, orders.listingId))
        .where(and(periodOrderCond, eq(orders.status, 'completed'), isNotNull(orders.completedAt))),
      // People
      db.select({ id: orders.buyerId, n: count() }).from(orders).where(periodOrderCond).groupBy(orders.buyerId),
      db.selectDistinct({ id: orders.sellerId }).from(orders).where(periodOrderCond),
      db.selectDistinct({ id: listings.sellerId }).from(listings).where(periodListingCond),
      // Chats -> orders by the same buyer on the same listing.
      db
        .select({
          chats: count(),
          ordered: sql<number>`coalesce(sum(${chatOrder(false)}), 0)`,
          completed: sql<number>`coalesce(sum(${chatOrder(true)}), 0)`,
        })
        .from(conversations)
        .where(and(eq(conversations.regionCode, code), inWindow(conversations.createdAt, start))),
      // Requests -> orders by the requester on that book, placed after the request.
      db
        .select({
          requests: count(),
          notified: sql<number>`coalesce(sum(${subscriptions.notifiedAt} IS NOT NULL AND ${subscriptions.notifiedAt} <> ''), 0)`,
          ordered: sql<number>`coalesce(sum(${requestOrder(false)}), 0)`,
          bought: sql<number>`coalesce(sum(${requestOrder(true)}), 0)`,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.regionCode, code), inWindow(subscriptions.createdAt, start))),
    ]);

  const firstChatAt = new Map(firstChat.map((r) => [r.listingId, r.at]));
  const firstOrderAt = new Map(firstOrder.map((r) => [r.listingId, r.at]));
  const soldListings = periodListings.filter((l) => l.status === 'sold').length;

  const buyers = new Set(buyerRows.map((r) => r.id));
  const sellers = new Set([...orderSellers.map((r) => r.id), ...listingSellers.map((r) => r.id)]);
  const both = [...buyers].filter((b) => sellers.has(b)).length;
  const union = new Set([...buyers, ...sellers]).size;
  const repeat = buyerRows.filter((r) => r.n >= 2).length;

  const chats = chatTotals[0];
  const reqs = requestTotals[0];

  return c.json({
    region: code,
    days,
    since: start,
    sell_through: {
      listings: periodListings.length,
      sold: soldListings,
      rate: ratio(soldListings, periodListings.length),
    },
    speed: {
      listing_to_first_chat: durations(periodListings.map((l) => [l.createdAt, firstChatAt.get(l.id)])),
      listing_to_first_order: durations(periodListings.map((l) => [l.createdAt, firstOrderAt.get(l.id)])),
      listing_to_sale: durations(sales.map((o) => [o.listingCreatedAt, o.completedAt])),
      order_to_completion: durations(sales.map((o) => [o.createdAt, o.completedAt])),
    },
    users: {
      buyers: buyers.size,
      sellers: sellers.size,
      both,
      overlap_rate: ratio(both, union),
      repeat_buyers: repeat,
      repeat_rate: ratio(repeat, buyers.size),
    },
    chat_to_order: {
      chats: chats.chats,
      ordered: chats.ordered,
      completed: chats.completed,
      order_rate: ratio(chats.ordered, chats.chats),
      completion_rate: ratio(chats.completed, chats.chats),
      // Every conversation here carries its creation time.
      undated: 0,
    },
    requests: {
      requests: reqs.requests,
      notified: reqs.notified,
      ordered: reqs.ordered,
      bought: reqs.bought,
      order_rate: ratio(reqs.ordered, reqs.requests),
    },
  });
});

// ---------------------------------------------------------------------------
// Retention: semester cohorts
// ---------------------------------------------------------------------------

const ROLES = ['all', 'buyer', 'seller'];

statsRoutes.get('/stats/retention', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const terms = optionalInt(c, 'terms') || 6;
  const role = c.req.query('role') || 'all';
  if (terms < 1 || terms > 8 || !ROLES.includes(role)) invalid();
  const tz = region.tz;

  const events: [string, string][] = [];
  const orderRows = await db
    .select({ buyerId: orders.buyerId, sellerId: orders.sellerId, createdAt: orders.createdAt })
    .from(orders)
    .where(eq(orders.regionCode, region.code));
  if (role === 'all' || role === 'buyer') for (const o of orderRows) events.push([o.buyerId, o.createdAt]);
  if (role === 'all' || role === 'seller') {
    const ls = await db
      .select({ sellerId: listings.sellerId, createdAt: listings.createdAt })
      .from(listings)
      .where(eq(listings.regionCode, region.code));
    for (const l of ls) events.push([l.sellerId, l.createdAt]);
    for (const o of orderRows) events.push([o.sellerId, o.createdAt]);
  }
  const active = new Map<string, Set<number>>();
  for (const [user, at] of events) {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) continue;
    const set = active.get(user) ?? new Set<number>();
    set.add(termIndex(ms, tz));
    active.set(user, set);
  }
  const current = termIndex(Date.now(), tz);
  const first = current - terms + 1;
  const cohorts = [];
  for (let term = first; term <= current; term++) {
    const members = [...active.values()].filter((seen) => Math.min(...seen) === term);
    const size = members.length;
    const retained = Array.from({ length: current - term + 1 }, (_, k) => members.filter((seen) => seen.has(term + k)).length);
    cohorts.push({ term: termLabel(term), size, retained, rates: retained.map((n) => ratio(n, size)) });
  }
  return c.json({
    region: region.code,
    role,
    terms: Array.from({ length: terms }, (_, i) => termLabel(first + i)),
    cohorts,
  });
});
