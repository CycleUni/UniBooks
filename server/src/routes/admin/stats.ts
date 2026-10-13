import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
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
 * Rows are fetched per region and aggregated here.
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

const since = (iso: string | null | undefined, start: string | null) => !start || (!!iso && iso >= start);

// ---------------------------------------------------------------------------
// Row loading (one region)
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  status: string;
  totalAmount: number;
  createdAt: string;
  completedAt: string | null;
  buyerId: string;
  sellerId: string;
  listingId: string | null;
  listingRef: string | null;
  cancelReason: string | null;
  bookId: string | null;
  schoolId: number | null;
  categoryId: number | null;
  courseName: string | null;
  professorName: string | null;
  listingCreatedAt: string | null;
}

async function regionOrders(db: Database, code: string): Promise<OrderRow[]> {
  return db
    .select({
      id: orders.id,
      status: orders.status,
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
      completedAt: orders.completedAt,
      buyerId: orders.buyerId,
      sellerId: orders.sellerId,
      listingId: orders.listingId,
      listingRef: orders.listingRef,
      cancelReason: orders.cancelReason,
      bookId: listings.bookId,
      schoolId: listings.schoolId,
      categoryId: listings.categoryId,
      courseName: listings.courseName,
      professorName: listings.professorName,
      listingCreatedAt: listings.createdAt,
    })
    .from(orders)
    .leftJoin(listings, eq(listings.id, orders.listingId))
    .where(eq(orders.regionCode, code));
}

interface ListingRow {
  id: string;
  sellerId: string;
  status: string;
  price: number;
  createdAt: string;
  bookId: string;
  schoolId: number | null;
  categoryId: number | null;
  courseName: string;
  professorName: string;
  condition: string;
}

async function regionListings(db: Database, code: string): Promise<ListingRow[]> {
  return db
    .select({
      id: listings.id,
      sellerId: listings.sellerId,
      status: listings.status,
      price: listings.price,
      createdAt: listings.createdAt,
      bookId: listings.bookId,
      schoolId: listings.schoolId,
      categoryId: listings.categoryId,
      courseName: listings.courseName,
      professorName: listings.professorName,
      condition: listings.condition,
    })
    .from(listings)
    .where(eq(listings.regionCode, code));
}

async function regionRequests(db: Database, code: string) {
  return db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      bookId: subscriptions.bookId,
      notifiedAt: subscriptions.notifiedAt,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.regionCode, code));
}
type RequestRow = Awaited<ReturnType<typeof regionRequests>>[number];

/** Users holding an active verification in the region (not deleted). */
async function regionUsers(db: Database, code: string) {
  return db
    .selectDistinct({ id: users.id, createdAt: users.createdAt })
    .from(users)
    .innerJoin(regionVerifications, eq(regionVerifications.userId, users.id))
    .where(and(eq(regionVerifications.regionCode, code), eq(regionVerifications.isActive, 1), sql`${users.deletedAt} IS NULL`));
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

function countBy<T>(rows: T[], key: (r: T) => string | number | null): Map<string | number | null, number> {
  const m = new Map<string | number | null, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function orderSeries(buckets: SeriesBuckets, rows: OrderRow[], withGmv = true) {
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

async function topSchools(db: Database, rows: OrderRow[], lang: string | null, withGmv = true, limit = 10) {
  const groups = new Map<number, { n: number; gmv: number }>();
  for (const o of rows) {
    if (o.status !== 'completed' || o.schoolId === null) continue;
    const g = groups.get(o.schoolId) ?? { n: 0, gmv: 0 };
    g.n++;
    g.gmv += o.totalAmount;
    groups.set(o.schoolId, g);
  }
  const top = [...groups.entries()].sort((a, b) => b[1].n - a[1].n || b[1].gmv - a[1].gmv || a[0] - b[0]).slice(0, limit);
  const found = await loadSchools(
    db,
    top.map(([id]) => id),
  );
  return top.map(([id, g]) => {
    const s = found.get(id);
    const item: Record<string, unknown> = {
      id,
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

/** Per-book transaction figures over `orders` (already scoped) and the region's active listings. */
function bookStats(orderRows: OrderRow[], activeListings: ListingRow[]): Map<string, BookStats> {
  const out = new Map<string, BookStats>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) {
      s = {
        order_count: 0,
        completed_count: 0,
        cancelled_count: 0,
        gmv: 0,
        avg_price: null,
        min_price: null,
        max_price: null,
        active_listings: 0,
      };
      out.set(id, s);
    }
    return s;
  };
  const prices = new Map<string, number[]>();
  for (const o of orderRows) {
    if (!o.bookId) continue;
    const s = get(o.bookId);
    s.order_count++;
    if (o.status === 'cancelled') s.cancelled_count++;
    if (o.status === 'completed') {
      s.completed_count++;
      s.gmv += o.totalAmount;
      prices.set(o.bookId, [...(prices.get(o.bookId) ?? []), o.totalAmount]);
    }
  }
  for (const [id, ps] of prices) {
    const s = get(id);
    s.avg_price = roundInt(avg(ps));
    s.min_price = Math.min(...ps);
    s.max_price = Math.max(...ps);
  }
  for (const l of activeListings) get(l.bookId).active_listings++;
  return out;
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

/** Books ranked by a figure over the period's orders (grouped on the listing's book, a deleted one included). */
function bookRanker(orderRows: OrderRow[], field: SortField): CompetitionRank {
  const groups = new Map<string | null, { order_count: number; completed_count: number; gmv: number }>();
  for (const o of orderRows) {
    const g = groups.get(o.bookId) ?? { order_count: 0, completed_count: 0, gmv: 0 };
    g.order_count++;
    if (o.status === 'completed') {
      g.completed_count++;
      g.gmv += o.totalAmount;
    }
    groups.set(o.bookId, g);
  }
  return new CompetitionRank([...groups.values()].map((g) => g[field]));
}

const TEXT_FIELDS = { course: 'courseName', professor: 'professorName' } as const;
const textKey = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/** Listings narrowed by ?school= ?category= ?course= ?professor=, or null. */
function listingScope(c: Context<AppEnv>, rows: ListingRow[]): Set<string> | null {
  let scoped = false;
  let out = rows;
  for (const name of ['school', 'category'] as const) {
    const raw = c.req.query(name);
    if (raw === undefined || raw === '') continue;
    scoped = true;
    const col = name === 'school' ? 'schoolId' : 'categoryId';
    if (raw === 'none') {
      out = out.filter((l) => l[col] === null);
      continue;
    }
    if (!/^\s*[+-]?\d+\s*$/.test(raw)) invalid();
    const id = Number(raw);
    out = out.filter((l) => l[col] === id);
  }
  for (const [name, col] of Object.entries(TEXT_FIELDS)) {
    const raw = c.req.query(name);
    if (!raw) continue;
    scoped = true;
    out = out.filter((l) => textKey(l[col]) === raw);
  }
  return scoped ? new Set(out.map((l) => l.id)) : null;
}

function requestSummary(reqs: RequestRow[], activeBookIds: Set<string>, start: string | null) {
  return {
    total: reqs.length,
    new: reqs.filter((r) => since(r.createdAt, start)).length,
    requested_books: new Set(reqs.map((r) => r.bookId)).size,
    unlisted_books: new Set(reqs.filter((r) => !activeBookIds.has(r.bookId)).map((r) => r.bookId)).size,
  };
}

interface RequestStats {
  request_count: number;
  new_requests: number;
  notified_count: number;
  waiting_count: number;
  active_listings: number;
  last_requested_at: string | null;
}

function requestStats(reqs: RequestRow[], activeListings: ListingRow[], start: string | null): Map<string, RequestStats> {
  const out = new Map<string, RequestStats>();
  for (const r of reqs) {
    const s = out.get(r.bookId) ?? {
      request_count: 0,
      new_requests: 0,
      notified_count: 0,
      waiting_count: 0,
      active_listings: 0,
      last_requested_at: null,
    };
    s.request_count++;
    if (since(r.createdAt, start)) s.new_requests++;
    if (r.notifiedAt) s.notified_count++;
    if (!s.last_requested_at || r.createdAt > s.last_requested_at) s.last_requested_at = r.createdAt;
    out.set(r.bookId, s);
  }
  const active = countBy(activeListings, (l) => l.bookId);
  for (const [id, s] of out) {
    s.active_listings = active.get(id) ?? 0;
    s.waiting_count = s.request_count - s.notified_count;
  }
  return out;
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

statsRoutes.get('/stats/overview/', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const lang = await resolveLanguage(c);
  const start = periodStart(region.tz, days);
  const code = region.code;

  const [orderRows, listingRows, reqs, regUsers] = await Promise.all([
    regionOrders(db, code),
    regionListings(db, code),
    regionRequests(db, code),
    regionUsers(db, code),
  ]);
  const periodOrders = orderRows.filter((o) => since(o.createdAt, start));
  const periodListings = listingRows.filter((l) => since(l.createdAt, start));

  const byStatus: Record<string, number> = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const o of periodOrders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  const completed = periodOrders.filter((o) => o.status === 'completed');
  const durations = completed.filter((o) => o.completedAt).map((o) => (Date.parse(o.completedAt!) - Date.parse(o.createdAt)) / 1000);
  const avgDuration = avg(durations);
  const done = byStatus.completed + byStatus.cancelled;
  const cancelReasons = [
    ...countBy(
      periodOrders.filter((o) => o.status === 'cancelled'),
      (o) => o.cancelReason || '',
    ).entries(),
  ]
    .map(([reason, count]) => ({ reason: String(reason), count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  const listingStatus: Record<string, number> = Object.fromEntries(LISTING_STATUSES.map((s) => [s, 0]));
  for (const l of listingRows) listingStatus[l.status] = (listingStatus[l.status] ?? 0) + 1;
  const activeListings = listingRows.filter((l) => l.status === 'active');

  // Moderation
  const listingReports = await db
    .select({ status: reports.status, reason: reports.reason, createdAt: reports.createdAt })
    .from(reports)
    .where(eq(reports.regionCode, code));
  const chatReportRows = await db
    .select({ status: chatReports.status, reason: chatReports.reason, createdAt: chatReports.createdAt })
    .from(chatReports)
    .innerJoin(conversations, eq(conversations.id, chatReports.conversationId))
    .where(eq(conversations.regionCode, code));
  const reasons = new Map<string, number>();
  for (const r of [...listingReports, ...chatReportRows]) {
    if (since(r.createdAt, start)) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  }

  // Reviews on this region's orders
  const reviewRows = (
    await db
      .select({ rating: reviews.rating, isNoShow: reviews.isNoShow, createdAt: reviews.createdAt })
      .from(reviews)
      .innerJoin(orders, eq(orders.id, reviews.orderId))
      .where(eq(orders.regionCode, code))
  ).filter((r) => since(r.createdAt, start));
  const ratings = reviewRows.filter((r) => !r.isNoShow && r.rating !== null).map((r) => r.rating as number);
  const avgRating = avg(ratings);

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

  return c.json({
    region: code,
    currency: region.defaultCurrency,
    days,
    since: start,
    users: {
      total: regUsers.length,
      new: regUsers.filter((u) => since(u.createdAt, start)).length,
      active_sellers: new Set(periodListings.map((l) => l.sellerId)).size,
      active_buyers: new Set(periodOrders.map((o) => o.buyerId)).size,
    },
    listings: {
      new: periodListings.length,
      by_status: listingStatus,
      avg_price: roundInt(avg(activeListings.map((l) => l.price))),
    },
    orders: {
      new: periodOrders.length,
      by_status: byStatus,
      completion_rate: ratio(byStatus.completed, done),
      cancel_rate: ratio(byStatus.cancelled, done),
      gmv: sum(completed.map((o) => o.totalAmount)),
      avg_order_value: roundInt(avg(completed.map((o) => o.totalAmount))),
      avg_days_to_complete: avgDuration === null ? null : roundHalfEven(avgDuration / DAY_SECONDS, 1),
      cancel_reasons: cancelReasons,
    },
    engagement: { conversations: conversationCount },
    requests: requestSummary(reqs, new Set(activeListings.map((l) => l.bookId)), start),
    moderation: {
      open_listing_reports: listingReports.filter((r) => r.status === 'open').length,
      open_chat_reports: chatReportRows.filter((r) => r.status === 'open').length,
      new_listing_reports: listingReports.filter((r) => since(r.createdAt, start)).length,
      new_chat_reports: chatReportRows.filter((r) => since(r.createdAt, start)).length,
      report_reasons: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    },
    reviews: {
      count: reviewRows.length,
      avg_rating: avgRating === null ? null : roundHalfEven(avgRating, 2),
      no_show_count: reviewRows.filter((r) => r.isNoShow).length,
    },
    ads: {
      active: adRows.filter((a) => a.isActive && a.advActive && a.startDate <= now && a.endDate >= now).length,
      views: adViews,
      clicks: adClicks,
      ctr: ratio(adClicks, adViews),
      stats_available: adTotals.available,
    },
    top_schools: await topSchools(db, periodOrders, lang),
  });
});

// ---------------------------------------------------------------------------
// Timeseries
// ---------------------------------------------------------------------------

statsRoutes.get('/stats/timeseries/', async (c) => {
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
    regionUsers(db, region.code),
  ]);
  const series = orderSeries(buckets, orderRows as OrderRow[]);
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

statsRoutes.get('/stats/books/ranking/', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const sort = c.req.query('sort') || 'completed';
  if (!(sort in SORT_FIELDS)) invalid();
  const sortField = SORT_FIELDS[sort as keyof typeof SORT_FIELDS];
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const q = (c.req.query('q') ?? '').trim();
  const start = periodStart(region.tz, days);

  const [orderRows, listingRows] = await Promise.all([regionOrders(db, region.code), regionListings(db, region.code)]);
  const scope = listingScope(c, listingRows);
  let periodOrders = orderRows.filter((o) => since(o.createdAt, start));
  if (scope) periodOrders = periodOrders.filter((o) => o.listingId !== null && scope.has(o.listingId));
  const activeListings = listingRows.filter((l) => l.status === 'active' && (!scope || scope.has(l.id)));
  const stats = bookStats(periodOrders, activeListings);

  let candidates: Book[];
  if (q) {
    const isbn = q.replace(/[- ]/g, '');
    const listedHere = new Set(listingRows.map((l) => l.bookId));
    const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const isbnPattern = `%${isbn.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const hits = await db
      .select()
      .from(books)
      .where(
        sql`(lower(${books.title}) LIKE ${pattern} ESCAPE '\\' OR lower(${books.authors}) LIKE ${pattern} ESCAPE '\\' OR ${books.isbn13} LIKE ${isbnPattern} ESCAPE '\\')`,
      );
    candidates = hits.filter((b) => b.regionCode === region.code || listedHere.has(b.id));
  } else {
    candidates = [
      ...(
        await loadBooks(
          db,
          periodOrders.flatMap((o) => (o.bookId ? [o.bookId] : [])),
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
  const ranker = bookRanker(periodOrders, sortField);
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

statsRoutes.get('/stats/books/requests/', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const unlistedOnly = ['1', 'true'].includes((c.req.query('unlisted') ?? '').toLowerCase());
  const q = (c.req.query('q') ?? '').trim();
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const start = periodStart(region.tz, days);

  const [reqs, listingRows] = await Promise.all([regionRequests(db, region.code), regionListings(db, region.code)]);
  const activeListings = listingRows.filter((l) => l.status === 'active');
  const stats = requestStats(reqs, activeListings, start);
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
  return c.json({
    ...page.wrap(results, rows.length),
    summary: requestSummary(reqs, new Set(activeListings.map((l) => l.bookId)), start),
  });
});

// ---------------------------------------------------------------------------
// Breakdown by school / category / course / professor
// ---------------------------------------------------------------------------

const BREAKDOWN_DIMENSIONS = ['school', 'category', 'course', 'professor'] as const;
const BREAKDOWN_SORTS = ['completed', 'gmv', 'orders', 'new_listings', 'active_listings'] as const;

statsRoutes.get('/stats/breakdown/', async (c) => {
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

  const [orderRowsAll, listingRowsAll] = await Promise.all([regionOrders(db, region.code), regionListings(db, region.code)]);
  let listingRows = listingRowsAll;
  let orderRows = orderRowsAll.filter((o) => since(o.createdAt, start));
  if (school) {
    listingRows = listingRows.filter((l) => l.schoolId === school);
    orderRows = orderRows.filter((o) => o.schoolId === school);
  }

  const textCol = by === 'course' ? 'courseName' : by === 'professor' ? 'professorName' : null;
  const fkCol = by === 'school' ? 'schoolId' : 'categoryId';
  const keyOfListing = (l: ListingRow): string | number | null => (textCol ? textKey(l[textCol]) : l[fkCol]);
  // An order whose listing is gone has no key; the join yields NULL,
  // which lands in the "none" row for a foreign key.
  const keyOfOrder = (o: OrderRow): string | number | null => (textCol ? textKey(o[textCol]) : (o[fkCol] ?? null));

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
  const labelCandidates = new Map<string | number | null, string[]>();
  for (const l of listingRows) {
    const k = keyOfListing(l);
    if (textCol && !k) continue;
    const r = rows.get(k) ?? { key: k, label: '', active_listings: 0, new_listings: 0, orders: 0, completed: 0, gmv: 0 };
    if (l.status === 'active') r.active_listings++;
    if (since(l.createdAt, start)) r.new_listings++;
    rows.set(k, r);
    if (textCol) labelCandidates.set(k, [...(labelCandidates.get(k) ?? []), (l[textCol] ?? '').trim()]);
  }
  if (textCol) {
    for (const [k, labels] of labelCandidates) rows.get(k)!.label = labels.sort()[0] ?? '';
  }
  for (const o of orderRows) {
    const r = rows.get(keyOfOrder(o));
    if (!r) continue;
    r.orders++;
    if (o.status === 'completed') {
      r.completed++;
      r.gmv += o.totalAmount;
    }
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
    summary.listings = listingRows.length;
    summary.listings_with_value = listingRows.filter((l) => (l[textCol] ?? '').trim() !== '').length;
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

statsRoutes.get('/stats/books/:id/', async (c) => {
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

  const [orderRows, listingRows, reqs] = await Promise.all([
    regionOrders(db, region.code),
    regionListings(db, region.code),
    regionRequests(db, region.code),
  ]);
  const periodOrders = orderRows.filter((o) => since(o.createdAt, start));
  const activeListings = listingRows.filter((l) => l.status === 'active');
  const stats = bookStats(periodOrders, activeListings).get(book.id) ?? emptyStats();
  const bookOrders = periodOrders.filter((o) => o.bookId === book.id);
  const allBookOrders = orderRows.filter((o) => o.bookId === book.id);

  const byStatus: Record<string, number> = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const o of bookOrders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  const summary = {
    ...stats,
    all_time_completed: allBookOrders.filter((o) => o.status === 'completed').length,
    rank: bookRanker(periodOrders, 'completed_count').rank(stats.completed_count),
  };

  const recent = [...allBookOrders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, 10);
  const bookActive = activeListings
    .filter((l) => l.bookId === book.id)
    .sort((a, b) => a.price - b.price || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, 20);
  const schoolMap = await loadSchools(
    db,
    [...recent, ...bookActive].flatMap((x) => (x.schoolId !== null ? [x.schoolId] : [])),
  );
  const schoolName = (sid: number | null) => {
    const s = sid !== null ? schoolMap.get(sid) : undefined;
    return s ? (lang ? localized(s.translations, lang, 'name', s.name) : s.name) : '';
  };

  const reqStats = requestStats(reqs, activeListings, start);
  const mine = reqStats.get(book.id) ?? {
    request_count: 0,
    new_requests: 0,
    notified_count: 0,
    waiting_count: 0,
    active_listings: 0,
    last_requested_at: null,
  };
  const { active_listings: _omit, ...requests } = mine;
  const buckets = new SeriesBuckets(region.tz, days);

  return c.json({
    region: region.code,
    currency: region.defaultCurrency,
    days,
    book: bookDict(book, true),
    summary,
    requests: { ...requests, rank: requestRanker(reqStats).rank(mine.request_count) },
    by_status: byStatus,
    series_unit: buckets.unit,
    series: orderSeries(buckets, allBookOrders, false),
    top_schools: await topSchools(db, bookOrders, lang, false),
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

statsRoutes.get('/stats/growth/', async (c) => {
  const db = createDb(c.env.DB);
  const region = await resolveStatsRegion(c, db);
  const days = parseDays(c);
  const start = periodStart(region.tz, days);
  const code = region.code;

  const [orderRows, listingRows, reqs, convs] = await Promise.all([
    regionOrders(db, code),
    regionListings(db, code),
    regionRequests(db, code),
    db
      .select({
        listingId: conversations.listingId,
        listingRef: conversations.listingRef,
        buyerId: conversations.buyerId,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(eq(conversations.regionCode, code)),
  ]);
  const periodListings = listingRows.filter((l) => since(l.createdAt, start));
  const periodOrders = orderRows.filter((o) => since(o.createdAt, start));

  // Liquidity: first chat / first order per listing.
  const firstChat = new Map<string, string>();
  for (const cv of convs) {
    if (cv.listingId && (!firstChat.has(cv.listingId) || cv.createdAt < firstChat.get(cv.listingId)!))
      firstChat.set(cv.listingId, cv.createdAt);
  }
  const firstOrder = new Map<string, string>();
  for (const o of orderRows) {
    if (o.listingId && (!firstOrder.has(o.listingId) || o.createdAt < firstOrder.get(o.listingId)!))
      firstOrder.set(o.listingId, o.createdAt);
  }
  const sales = periodOrders.filter((o) => o.status === 'completed' && o.completedAt);

  // People
  const buyerCounts = countBy(periodOrders, (o) => o.buyerId);
  const buyers = new Set([...buyerCounts.keys()] as string[]);
  const sellers = new Set([...periodOrders.map((o) => o.sellerId), ...periodListings.map((l) => l.sellerId)]);
  const both = [...buyers].filter((b) => sellers.has(b)).length;
  const union = new Set([...buyers, ...sellers]).size;
  const repeat = [...buyerCounts.values()].filter((n) => n >= 2).length;

  // Chats -> orders by the same buyer on the same listing.
  const ref = (x: { listingRef: string | null; listingId: string | null }) => x.listingRef ?? x.listingId;
  const ordered = new Set<string>();
  const sold = new Set<string>();
  for (const o of orderRows) {
    const k = `${ref(o)}|${o.buyerId}`;
    ordered.add(k);
    if (o.status === 'completed') sold.add(k);
  }
  const periodChats = convs.filter((cv) => since(cv.createdAt, start));
  const chatOrdered = periodChats.filter((cv) => ordered.has(`${ref(cv)}|${cv.buyerId}`)).length;
  const chatSold = periodChats.filter((cv) => sold.has(`${ref(cv)}|${cv.buyerId}`)).length;

  // Requests -> orders by the requester on that book, placed after the request.
  const periodReqs = reqs.filter((r) => since(r.createdAt, start));
  const reqOutcome = periodReqs.map((r) => {
    const mine = orderRows.filter((o) => o.buyerId === r.userId && o.bookId === r.bookId && o.createdAt >= r.createdAt);
    return { r, ordered: mine.length > 0, bought: mine.some((o) => o.status === 'completed') };
  });
  const reqOrdered = reqOutcome.filter((x) => x.ordered).length;

  return c.json({
    region: code,
    days,
    since: start,
    sell_through: {
      listings: periodListings.length,
      sold: periodListings.filter((l) => l.status === 'sold').length,
      rate: ratio(periodListings.filter((l) => l.status === 'sold').length, periodListings.length),
    },
    speed: {
      listing_to_first_chat: durations(periodListings.map((l) => [l.createdAt, firstChat.get(l.id)])),
      listing_to_first_order: durations(periodListings.map((l) => [l.createdAt, firstOrder.get(l.id)])),
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
      chats: periodChats.length,
      ordered: chatOrdered,
      completed: chatSold,
      order_rate: ratio(chatOrdered, periodChats.length),
      completion_rate: ratio(chatSold, periodChats.length),
      // Every conversation here carries its creation time.
      undated: 0,
    },
    requests: {
      requests: periodReqs.length,
      notified: periodReqs.filter((r) => r.notifiedAt).length,
      ordered: reqOrdered,
      bought: reqOutcome.filter((x) => x.bought).length,
      order_rate: ratio(reqOrdered, periodReqs.length),
    },
  });
});

// ---------------------------------------------------------------------------
// Retention: semester cohorts
// ---------------------------------------------------------------------------

const ROLES = ['all', 'buyer', 'seller'];

statsRoutes.get('/stats/retention/', async (c) => {
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
