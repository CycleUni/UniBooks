import type { Env } from '../../env';
import { cachedJson } from './adCache';

/**
 * Ad impression / click figures, read back from Workers Analytics Engine.
 *
 * The public view/click endpoints write one data point per hit to the
 * AD_EVENTS dataset (routes/promotions.ts):
 *   index1 = ad id, blob1 = 'view' | 'click', blob2 = region code,
 *   blob3 = position, blob4 = per-day client hash, double1 = 1.
 * Analytics Engine samples, so counts are SUM(_sample_interval); uniques
 * count distinct (client, day) hashes. Data is kept for about three months,
 * so "lifetime" figures mean the retention window.
 *
 * Without CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN (local dev, tests) or when the
 * SQL API fails, every figure is 0 and `available` is false.
 */

export const AD_EVENTS_DATASET = 'unibooks_ad_events';
const CACHE_TTL = 300;

export interface AdCounts {
  views: number;
  clicks: number;
  uniqueViews: number;
  uniqueClicks: number;
}

export const ZERO_COUNTS: AdCounts = { views: 0, clicks: 0, uniqueViews: 0, uniqueClicks: 0 };

export interface AdCountsResult {
  available: boolean;
  counts: Map<number, AdCounts>;
}

type Row = Record<string, string | number | null>;

const configured = (env: Env) => !!(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN);

/** Run one statement against the Analytics Engine SQL API; null on any failure. */
export async function queryAdEvents(env: Env, sqlText: string): Promise<Row[] | null> {
  if (!configured(env)) return null;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID!)}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'text/plain' },
        body: sqlText,
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Row[] };
    return Array.isArray(json.data) ? json.data : null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The SQL for per-ad counts (exported for tests). Ids must be safe integers. */
export function adCountsSql(adIds: number[]): string {
  const list = adIds.map((id) => `'${id}'`).join(', ');
  return (
    `SELECT index1 AS ad, blob1 AS event, SUM(_sample_interval) AS n, COUNT(DISTINCT blob4) AS u ` +
    `FROM ${AD_EVENTS_DATASET} WHERE index1 IN (${list}) GROUP BY index1, blob1 FORMAT JSON`
  );
}

/**
 * View / click counts for a page of ads in ONE query, cached in KV for
 * five minutes per set of ids.
 */
export async function adCounts(env: Env, adIds: number[]): Promise<AdCountsResult> {
  const ids = [...new Set(adIds.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  const counts = new Map<number, AdCounts>(ids.map((id) => [id, { ...ZERO_COUNTS }]));
  if (!configured(env)) return { available: false, counts };
  if (!ids.length) return { available: true, counts };
  const key = `ads:stats:${(await sha256Hex(ids.join(','))).slice(0, 32)}`;
  const rows = await cachedJson(env.KV, key, CACHE_TTL, async () => (await queryAdEvents(env, adCountsSql(ids))) ?? undefined);
  if (!rows) return { available: false, counts };
  for (const r of rows) {
    const c = counts.get(Number(r.ad));
    if (!c) continue;
    if (r.event === 'view') {
      c.views += num(r.n);
      c.uniqueViews += num(r.u);
    } else if (r.event === 'click') {
      c.clicks += num(r.n);
      c.uniqueClicks += num(r.u);
    }
  }
  return { available: true, counts };
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) for Analytics Engine's toDateTime(). */
function aeDateTime(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/** The SQL for a region's totals (exported for tests). */
export function regionTotalsSql(regionCode: string, since: string | null): string | null {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(regionCode)) return null;
  const conds = [`blob2 = '${regionCode}'`];
  const at = since ? aeDateTime(since) : null;
  if (at) conds.push(`timestamp >= toDateTime('${at}')`);
  return `SELECT blob1 AS event, SUM(_sample_interval) AS n FROM ${AD_EVENTS_DATASET} WHERE ${conds.join(' AND ')} GROUP BY blob1 FORMAT JSON`;
}

/**
 * Views and clicks recorded in a region since `since` (null = the whole
 * retention window), cached in KV for five minutes.
 */
export async function regionAdTotals(
  env: Env,
  regionCode: string,
  since: string | null,
): Promise<{ available: boolean; views: number; clicks: number }> {
  const sqlText = regionTotalsSql(regionCode, since);
  if (!configured(env) || !sqlText) return { available: false, views: 0, clicks: 0 };
  const key = `ads:region-stats:${regionCode}:${since ?? 'all'}`;
  const rows = await cachedJson(env.KV, key, CACHE_TTL, async () => (await queryAdEvents(env, sqlText)) ?? undefined);
  if (!rows) return { available: false, views: 0, clicks: 0 };
  let views = 0;
  let clicks = 0;
  for (const r of rows) {
    if (r.event === 'view') views += num(r.n);
    else if (r.event === 'click') clicks += num(r.n);
  }
  return { available: true, views, clicks };
}
