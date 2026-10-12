import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

/**
 * Admin statistics. Every call names exactly one region and every money
 * figure in the answer is in that region's `currency` (minor units), so
 * amounts from different regions are never added together.
 */

/** 1 is today (from local midnight); 0 is all time. */
export type StatsDays = 1 | 7 | 30 | 90 | 365 | 0;
/** Chart buckets: hours for today, days otherwise. */
export type SeriesUnit = 'hour' | 'day';
export type BookRankingSort = 'completed' | 'gmv' | 'orders';
export type OrderStatusCounts = Record<'pending' | 'accepted' | 'handed_over' | 'completed' | 'cancelled', number>;

export interface ReasonCount {
  reason: string;
  count: number;
}

export interface AdminStatsOverview {
  region: string;
  currency: string;
  days: StatsDays;
  since: string | null;
  users: { total: number; new: number; active_sellers: number; active_buyers: number };
  listings: {
    new: number;
    by_status: Record<'active' | 'reserved' | 'sold' | 'removed', number>;
    avg_price: number | null;
  };
  orders: {
    new: number;
    by_status: OrderStatusCounts;
    completion_rate: number | null;
    cancel_rate: number | null;
    gmv: number;
    avg_order_value: number | null;
    avg_days_to_complete: number | null;
    cancel_reasons: ReasonCount[];
  };
  engagement: { conversations: number };
  requests: RequestSummary;
  moderation: {
    open_listing_reports: number;
    open_chat_reports: number;
    new_listing_reports: number;
    new_chat_reports: number;
    report_reasons: ReasonCount[];
  };
  reviews: { count: number; avg_rating: number | null; no_show_count: number };
  ads: { active: number; views: number; clicks: number; ctr: number | null };
  top_schools: { id: number; name: string; completed_orders: number; gmv: number }[];
}

export interface AdminStatsTimeseries {
  region: string;
  currency: string;
  days: StatsDays;
  unit: SeriesUnit;
  /** `date` is the bucket label: 2026-09-17 for a day, 14:00 for an hour. */
  series: { date: string; orders: number; completed: number; gmv: number; new_users: number; new_listings: number }[];
}

export interface StatsBook {
  id: number;
  title: string;
  authors: string;
  isbn13: string | null;
  cover_url: string;
}

export interface BookStatsFigures {
  completed_count: number;
  order_count: number;
  cancelled_count: number;
  gmv: number;
  avg_price: number | null;
  min_price: number | null;
  max_price: number | null;
  active_listings: number;
}

export interface AdminBookRankingRow extends BookStatsFigures {
  /** Competition rank by the chosen sort; null when the book has no value for it. */
  rank: number | null;
  book: StatsBook;
}

export interface AdminBookRanking {
  count: number;
  next: string | null;
  previous: string | null;
  currency: string;
  sort: BookRankingSort;
  results: AdminBookRankingRow[];
}

/** Book requests ("求書"): unmet demand, reported apart from transactions. */
export interface RequestSummary {
  total: number;
  new: number;
  requested_books: number;
  unlisted_books: number;
}

export interface RequestFigures {
  request_count: number;
  new_requests: number;
  notified_count: number;
  waiting_count: number;
  last_requested_at: string | null;
}

export interface AdminBookRequestRow extends RequestFigures {
  rank: number | null;
  book: StatsBook;
  active_listings: number;
}

export interface AdminBookRequests {
  count: number;
  next: string | null;
  previous: string | null;
  summary: RequestSummary;
  results: AdminBookRequestRow[];
}

export type BreakdownDimension = 'school' | 'category' | 'course' | 'professor';
export type BreakdownSort = 'completed' | 'gmv' | 'orders' | 'new_listings' | 'active_listings';

/**
 * Narrows the book ranking to one breakdown row. `none` selects listings with
 * no school / category; course and professor take the row's `key`.
 */
export interface BookScope {
  school?: number | 'none' | null;
  category?: number | 'none' | null;
  course?: string;
  professor?: string;
}

export interface BreakdownRow {
  /** School or category id; absent for course / professor, null for "not set". */
  id?: number | null;
  /** Course / professor grouping key (trimmed, lower-cased); pass back as BookScope. */
  key?: string;
  /** Display name; '' for listings with no school / category. */
  label: string;
  /** By school: its name in every language and its code, for the school filter's search. */
  keywords?: string[];
  rank: number | null;
  active_listings: number;
  new_listings: number;
  orders: number;
  completed: number;
  gmv: number;
}

export interface AdminStatsBreakdown {
  region: string;
  currency: string;
  days: StatsDays;
  by: BreakdownDimension;
  sort: BreakdownSort;
  count: number;
  /** For course / professor, how many listings name one at all. */
  summary: { groups: number; listings?: number; listings_with_value?: number };
  results: BreakdownRow[];
}

export interface DurationFigure {
  count: number;
  avg_days: number | null;
  median_days: number | null;
}

export interface AdminStatsGrowth {
  region: string;
  days: StatsDays;
  since: string | null;
  sell_through: { listings: number; sold: number; rate: number | null };
  speed: {
    listing_to_first_chat: DurationFigure;
    listing_to_first_order: DurationFigure;
    listing_to_sale: DurationFigure;
    order_to_completion: DurationFigure;
  };
  users: {
    buyers: number; sellers: number; both: number; overlap_rate: number | null;
    repeat_buyers: number; repeat_rate: number | null;
  };
  chat_to_order: {
    chats: number; ordered: number; completed: number;
    order_rate: number | null; completion_rate: number | null;
    /** Chats from before their start time was recorded; not dated, so outside any period. */
    undated: number;
  };
  requests: { requests: number; notified: number; ordered: number; bought: number; order_rate: number | null };
}

export type RetentionRole = 'all' | 'buyer' | 'seller';

export interface AcademicTerm {
  year: number;
  season: 'spring' | 'autumn';
}

export interface AdminStatsRetention {
  region: string;
  role: RetentionRole;
  terms: AcademicTerm[];
  cohorts: { term: AcademicTerm; size: number; retained: number[]; rates: (number | null)[] }[];
}

export interface AdminBookStats {
  region: string;
  currency: string;
  days: StatsDays;
  book: StatsBook & { publisher: string; published_date: string; source: string };
  summary: BookStatsFigures & { all_time_completed: number; rank: number | null };
  requests: RequestFigures & { rank: number | null };
  by_status: OrderStatusCounts;
  series_unit: SeriesUnit;
  series: { date: string; orders: number; completed: number }[];
  top_schools: { id: number; name: string; completed_orders: number }[];
  recent_orders: { id: string; status: string; total_amount: number; school_name: string; created_at: string }[];
  active_listings: { id: string; price: number; condition: string; school_name: string; created_at: string }[];
}

function params(values: object): HttpParams {
  let p = new HttpParams();
  for (const [key, value] of Object.entries(values) as [string, string | number | null | undefined][]) {
    if (value !== undefined && value !== null && value !== '') p = p.set(key, String(value));
  }
  return p;
}

@Injectable({ providedIn: 'root' })
export class AdminStatsService {
  private http = inject(HttpClient);

  getOverview(region: string, days: StatsDays): Observable<AdminStatsOverview> {
    return this.http.get<AdminStatsOverview>('/admin/stats/overview/', { params: params({ region, days }) });
  }

  getTimeseries(region: string, days: StatsDays): Observable<AdminStatsTimeseries> {
    return this.http.get<AdminStatsTimeseries>('/admin/stats/timeseries/', { params: params({ region, days }) });
  }

  getBookRanking(opts: {
    region: string;
    days: StatsDays;
    sort: BookRankingSort;
    q?: string;
    page?: number;
    page_size?: number;
  } & BookScope): Observable<AdminBookRanking> {
    return this.http.get<AdminBookRanking>('/admin/stats/books/ranking/', { params: params(opts) });
  }

  getBookRequests(opts: {
    region: string;
    days: StatsDays;
    unlisted?: boolean;
    q?: string;
    page?: number;
    page_size?: number;
  }): Observable<AdminBookRequests> {
    const { unlisted, ...rest } = opts;
    return this.http.get<AdminBookRequests>('/admin/stats/books/requests/', {
      params: params({ ...rest, unlisted: unlisted ? 1 : undefined }),
    });
  }

  getBreakdown(opts: {
    region: string;
    days: StatsDays;
    by: BreakdownDimension;
    sort: BreakdownSort;
    school?: number | null;
    q?: string;
    page?: number;
    page_size?: number;
  }): Observable<AdminStatsBreakdown> {
    return this.http.get<AdminStatsBreakdown>('/admin/stats/breakdown/', { params: params(opts) });
  }

  getGrowth(region: string, days: StatsDays): Observable<AdminStatsGrowth> {
    return this.http.get<AdminStatsGrowth>('/admin/stats/growth/', { params: params({ region, days }) });
  }

  getRetention(region: string, role: RetentionRole, terms = 6): Observable<AdminStatsRetention> {
    return this.http.get<AdminStatsRetention>('/admin/stats/retention/', { params: params({ region, role, terms }) });
  }

  getBookStats(id: number, region: string, days: StatsDays): Observable<AdminBookStats> {
    return this.http.get<AdminBookStats>(`/admin/stats/books/${id}/`, { params: params({ region, days }) });
  }
}
