import type { Env } from '../../env';
import { cachedJson } from './adCache';
import { localParts, periodStart, ratio, safeTimeZone, SeriesBuckets, zonedMidnight } from './statsTime';

/**
 * Active account statistics, read back from Workers Analytics Engine.
 *
 * Activity tracking writes one data point per authenticated user action to the
 * ACTIVITY_EVENTS dataset (dataset: 'unibooks_activity'):
 *   index1 = userId (sampling key, ensuring equitable sampling decisions are consistent per user)
 *   blob1 = regionCode (e.g. 'TW', 'HK') or ''
 *   blob2 = userId
 *   double1 = 1
 *
 * Distinct Counting & Sampling in Cloudflare Workers Analytics Engine:
 * Official documentation:
 *   - SQL Reference: https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/
 *   - Sampling & Aggregates: https://developers.cloudflare.com/analytics/analytics-engine/sampling/
 *
 * In the Analytics Engine SQL dialect:
 * 1. `COUNT(DISTINCT <column>)` is officially supported for column names (blobs, indexes)
 *    as a compatibility exception. Row-level `SELECT DISTINCT` is not supported.
 * 2. Analytics Engine uses write-time adaptive sampling based on index1 (`indexes: [userId]`).
 *    Because `userId` is the index, all events for a given user share the exact same
 *    sampling hash (they are all kept or all dropped together).
 * 3. `_sample_interval` records the inverse sampling rate for each row. Standard event counts
 *    scale via `SUM(_sample_interval)`, whereas `COUNT(DISTINCT blob2)` counts distinct users
 *    present in the retained data stream.
 * 4. For standard application loads well below the platform sampling limit (~10M writes/day),
 *    data is completely unsampled (`_sample_interval = 1`), and `COUNT(DISTINCT blob2)`
 *    provides exact distinct user counts. If high-throughput adaptive sampling were triggered
 *    (`_sample_interval > 1`), `COUNT(DISTINCT blob2)` reflects unique users in the retained sample.
 *
 * Data retention in Analytics Engine is approximately 3 months (~90 days).
 * Answers are cached in KV for 10 minutes (600s).
 */

export const ACTIVITY_EVENTS_DATASET = 'unibooks_activity';
const CACHE_TTL = 600; // 10 minutes

export interface ActiveUserCounts {
  available: true;
  region: string | null;
  days: number;
  today_dau: number;
  active_7d: number;
  active_30d: number;
  stickiness: number | null;
  dau_series: { date: string; dau: number }[];
  mau_series: { month: string; mau: number }[];
}

export interface ActiveUserUnavailable {
  available: false;
}

export type ActiveUsersResult = ActiveUserCounts | ActiveUserUnavailable;

type Row = Record<string, string | number | null>;

const configured = (env: Env) => !!(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN);

/** Run one statement against the Analytics Engine SQL API; returns null on any error or timeout. */
export async function queryActivityEvents(env: Env, sqlText: string): Promise<Row[] | null> {
  if (!configured(env)) return null;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID!)}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'text/plain' },
        body: sqlText,
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Row[] };
    return Array.isArray(json.data) ? json.data : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

/** Convert ISO 8601 UTC string to 'YYYY-MM-DD HH:MM:SS' for Analytics Engine toDateTime(). */
export function aeDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '1970-01-01 00:00:00';
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Generate [start, end) boundaries for the last `count` calendar months in `tz`.
 * Boundaries align to midnight on the 1st of each calendar month in the region's time zone.
 */
export function calendarMonthBounds(tz: string, count = 3, now = Date.now()): { label: string; start: string; end: string }[] {
  const p = localParts(now, tz);
  const out: { label: string; start: string; end: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    let year = p.year;
    let month = p.month - i;
    while (month < 1) {
      month += 12;
      year -= 1;
    }
    const label = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    let nextYear = year;
    let nextMonth = month + 1;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    const startMs = zonedMidnight(year, month, 1, tz);
    const endMs = zonedMidnight(nextYear, nextMonth, 1, tz);
    out.push({
      label,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    });
  }
  return out;
}

type Bound = { label: string; start: string; end: string };

/**
 * One row per calendar day or month of the region, with its distinct users.
 * The bucket is the timestamp formatted in the region's time zone
 * (formatDateTime takes one), not a CASE over the bounds: CASE is not in
 * Analytics Engine's SQL reference, and formatDateTime is.
 * https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/date-time-functions/
 */
function bucketSql(alias: string, value: string, format: string, bounds: Bound[], tz: string, regionCode?: string | null): string {
  const conds = [
    `timestamp >= toDateTime('${aeDateTime(bounds[0].start)}')`,
    `timestamp < toDateTime('${aeDateTime(bounds[bounds.length - 1].end)}')`,
  ];
  if (regionCode && /^[A-Za-z0-9_-]{1,16}$/.test(regionCode)) conds.push(`blob1 = '${regionCode}'`);
  const zone = /^[A-Za-z0-9_+\-/]{1,64}$/.test(tz) ? tz : 'Etc/UTC';
  return `SELECT formatDateTime(timestamp, '${format}', '${zone}') AS ${alias}, COUNT(DISTINCT blob2) AS ${value} FROM ${ACTIVITY_EVENTS_DATASET} WHERE ${conds.join(' AND ')} GROUP BY ${alias} FORMAT JSON`;
}

/** SQL for DAU per day of the region's time zone, labelled YYYY-MM-DD (exported for tests). */
export function dauSql(bounds: Bound[], tz: string, regionCode?: string | null): string {
  return bucketSql('bucket', 'dau', '%Y-%m-%d', bounds, tz, regionCode);
}

/** SQL for MAU per calendar month of the region's time zone, labelled YYYY-MM (exported for tests). */
export function mauSql(bounds: Bound[], tz: string, regionCode?: string | null): string {
  return bucketSql('month', 'mau', '%Y-%m', bounds, tz, regionCode);
}

/** SQL to count distinct active users over a rolling window [startIso, endIso) (exported for tests). */
export function rollingActiveSql(startIso: string, endIso: string, regionCode?: string | null): string {
  const startAt = aeDateTime(startIso);
  const endAt = aeDateTime(endIso);
  const conds = [`timestamp >= toDateTime('${startAt}')`, `timestamp < toDateTime('${endAt}')`];
  if (regionCode && /^[A-Za-z0-9_-]{1,16}$/.test(regionCode)) {
    conds.push(`blob1 = '${regionCode}'`);
  }
  return `SELECT COUNT(DISTINCT blob2) AS active_users FROM ${ACTIVITY_EVENTS_DATASET} WHERE ${conds.join(' AND ')} FORMAT JSON`;
}

export interface ActivityAnalyticsOptions {
  regionCode?: string | null;
  tz?: string;
  days?: number;
}

/**
 * Query active accounts (DAU, MAU, 7d/30d active, stickiness) from Analytics Engine,
 * cached in KV for 10 minutes.
 */
export async function activeUserAnalytics(env: Env, opts: ActivityAnalyticsOptions = {}, now = Date.now()): Promise<ActiveUsersResult> {
  if (!configured(env)) {
    return { available: false };
  }

  const regionCode = opts.regionCode ? opts.regionCode.toUpperCase() : null;
  const tz = safeTimeZone(opts.tz);
  const days = Math.min(Math.max(1, opts.days ?? 30), 90);

  const key = `activity:stats:${regionCode ?? 'all'}:${days}`;

  const cached = await cachedJson<ActiveUserCounts>(env.KV, key, CACHE_TTL, async () => {
    // 1. DAU buckets
    const dayBuckets = new SeriesBuckets(tz, days, now);
    const dayBounds = dayBuckets.bounds();
    const dauQuery = dauSql(dayBounds, tz, regionCode);

    // 2. MAU calendar months (last 3 months)
    const monthBounds = calendarMonthBounds(tz, 3, now);
    const mauQuery = mauSql(monthBounds, tz, regionCode);

    // 3. Rolling active: 7 days, 30 days
    const start7d = periodStart(tz, 7, now) ?? dayBounds[Math.max(0, dayBounds.length - 7)].start;
    const start30d = periodStart(tz, 30, now) ?? dayBounds[Math.max(0, dayBounds.length - 30)].start;
    const endWindow = dayBounds[dayBounds.length - 1].end;

    const rolling7dQuery = rollingActiveSql(start7d, endWindow, regionCode);
    const rolling30dQuery = rollingActiveSql(start30d, endWindow, regionCode);

    // Execute queries in parallel
    const [dauRows, mauRows, active7dRows, active30dRows] = await Promise.all([
      queryActivityEvents(env, dauQuery),
      queryActivityEvents(env, mauQuery),
      queryActivityEvents(env, rolling7dQuery),
      queryActivityEvents(env, rolling30dQuery),
    ]);

    // If any query failed, we treat stats as unavailable
    if (!dauRows || !mauRows || !active7dRows || !active30dRows) {
      return undefined;
    }

    // Build DAU series
    const dauMap = new Map<string, number>();
    for (const r of dauRows) {
      if (typeof r.bucket === 'string') dauMap.set(r.bucket, num(r.dau));
    }
    const dau_series = dayBounds.map((b) => ({
      date: b.label,
      dau: dauMap.get(b.label) ?? 0,
    }));

    // Today's DAU is the latest day bucket (today in local tz)
    const today_dau = dau_series.length ? dau_series[dau_series.length - 1].dau : 0;

    // Build MAU series
    const mauMap = new Map<string, number>();
    for (const r of mauRows) {
      if (typeof r.month === 'string') mauMap.set(r.month, num(r.mau));
    }
    const mau_series = monthBounds.map((b) => ({
      month: b.label,
      mau: mauMap.get(b.label) ?? 0,
    }));

    // Rolling active users
    const active_7d = active7dRows.length ? num(active7dRows[0].active_users) : 0;
    const active_30d = active30dRows.length ? num(active30dRows[0].active_users) : 0;

    // Stickiness: average DAU over the last 30 days / 30-day active
    // If days < 30, take whatever days we have; if >= 30, take the last 30 days
    const last30Dau = dau_series.slice(-30);
    const sum30dDau = last30Dau.reduce((sum, item) => sum + item.dau, 0);
    const count30d = Math.max(1, last30Dau.length);
    const avg30dDau = sum30dDau / count30d;
    const stickiness = active_30d > 0 ? ratio(avg30dDau, active_30d, 4) : null;

    return {
      available: true,
      region: regionCode,
      days,
      today_dau,
      active_7d,
      active_30d,
      stickiness,
      dau_series,
      mau_series,
    };
  });

  return cached ?? { available: false };
}
