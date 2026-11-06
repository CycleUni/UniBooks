import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Env } from '../env';
import { schema } from '../db';
import { storeGet, storePut } from '../lib/cache';
import { probeGoogleBooks, probeIsbnnet, probeOpenLibrary, sourceBackoff, type ProbeResult } from './catalog/lookups';

/** Every table the schema declares; a deploy whose migrations are behind lacks some. */
const SCHEMA_TABLES = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable)).map((t) => getTableName(t));

export interface CoreHealth {
  database: boolean;
  cache: boolean;
  migrations: boolean;
  /** Schema tables missing from D1; null when the check itself failed. */
  unapplied: number | null;
}

/** D1, KV and the migration state: what /core/healthz reports. */
export async function coreHealth(env: Env): Promise<CoreHealth> {
  // Raw: probes of D1 itself, not of a schema table.
  let database = false;
  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    database = row?.ok === 1;
  } catch (e) {
    console.error('[healthz] database failure', e);
  }

  // KV is the cache. Read-only: a write per probe would spend KV's write budget.
  let cache = false;
  try {
    await env.KV.get('healthz_probe');
    cache = true;
  } catch (e) {
    console.error('[healthz] cache failure', e);
  }

  let migrations = false;
  let unapplied: number | null = null;
  try {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const present = new Set(results.map((r) => r.name));
    unapplied = SCHEMA_TABLES.filter((name) => !present.has(name)).length;
    migrations = unapplied === 0;
  } catch (e) {
    console.error('[healthz] migrations check failure', e);
  }

  return { database, cache, migrations, unapplied };
}

export type CheckStatus = ProbeResult['status'];

export interface HealthCheck extends Partial<ProbeResult> {
  name: 'database' | 'cache' | 'migrations' | 'google_books' | 'open_library' | 'isbnnet';
  group: 'core' | 'external';
  status: CheckStatus;
}

const RANK: Record<CheckStatus, number> = { ok: 0, degraded: 1, error: 2 };
const worst = (checks: { status: CheckStatus }[]) => checks.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'ok');

/**
 * External probe results are kept in this data centre's edge cache: 5 minutes
 * while every source answers, 30 seconds once one does not, so an outage is
 * seen to clear soon after it does. Each probe spends a Google Books call
 * from the shared budget and makes the resolver crawl the library site.
 */
const EXTERNAL_CACHE_KEY = 'health:external:v1';
export const EXTERNAL_OK_TTL = 300;
export const EXTERNAL_FAILING_TTL = 30;

interface ExternalSnapshot {
  checked_at: string;
  checks: HealthCheck[];
}

async function externalHealth(env: Env): Promise<ExternalSnapshot & { cached: boolean }> {
  try {
    const hit = await storeGet(EXTERNAL_CACHE_KEY);
    if (hit) return { ...(JSON.parse(hit) as ExternalSnapshot), cached: true };
  } catch (e) {
    console.warn('[health] external cache read failed; probing live', e);
  }
  const [google, openLibrary, isbnnet] = await Promise.all([probeGoogleBooks(env), probeOpenLibrary(env), probeIsbnnet(env)]);
  const snapshot: ExternalSnapshot = {
    checked_at: new Date().toISOString(),
    checks: [
      { name: 'google_books', group: 'external', ...google },
      { name: 'open_library', group: 'external', ...openLibrary },
      { name: 'isbnnet', group: 'external', ...isbnnet },
    ],
  };
  try {
    await storePut(EXTERNAL_CACHE_KEY, JSON.stringify(snapshot), worst(snapshot.checks) === 'ok' ? EXTERNAL_OK_TTL : EXTERNAL_FAILING_TTL);
  } catch (e) {
    console.warn('[health] external cache write failed', e);
  }
  return { ...snapshot, cached: false };
}

export interface SystemHealth {
  status: CheckStatus;
  /** When the core checks ran: always this request. */
  checked_at: string;
  /** When the external probes ran: this request, or the cached snapshot's time. */
  external_checked_at: string;
  external_cached: boolean;
  checks: HealthCheck[];
}

/**
 * The admin status page: the core checks (live) plus one call to each
 * catalogue source (cached, above). Kept off the public /healthz on purpose: an
 * uptime monitor should not page anyone (or spend Google's quota) because a
 * third-party source is down, since lookups fall back to the other sources.
 */
export async function systemHealth(env: Env): Promise<SystemHealth> {
  const [core, external, backoff] = await Promise.all([coreHealth(env), externalHealth(env), sourceBackoff(env)]);
  const ok = (good: boolean): CheckStatus => (good ? 'ok' : 'error');
  const checks: HealthCheck[] = [
    { name: 'database', group: 'core', status: ok(core.database) },
    { name: 'cache', group: 'core', status: ok(core.cache) },
    {
      name: 'migrations',
      group: 'core',
      status: ok(core.migrations),
      ...(core.migrations ? {} : { detail: core.unapplied === null ? 'unreachable' : `unapplied_${core.unapplied}` }),
    },
    // The skip flags are read live: a cached snapshot must not show a stale one.
    ...external.checks.map((c) => {
      const until = backoff[c.name as keyof typeof backoff];
      return until ? { ...c, skipping_until: until } : c;
    }),
  ];
  return {
    status: worst(checks),
    checked_at: new Date().toISOString(),
    external_checked_at: external.checked_at,
    external_cached: external.cached,
    checks,
  };
}
