import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { activeUserAnalytics, calendarMonthBounds, dauSql, mauSql, rollingActiveSql } from '../../src/services/admin/activityAnalytics';
import { _resetActivityThrottle, shouldRecordActivity } from '../../src/middleware/auth';
import { SeriesBuckets } from '../../src/services/admin/statsTime';
import { app, call, staff } from '../ads/helpers';
import { accountRoutes } from '../../src/routes/accounts';
import { createUser, seedReference } from '../accounts/helpers';
import { signToken } from '../../src/lib/jwt';

app.route('/api/v1/auth', accountRoutes);

beforeEach(() => {
  _resetActivityThrottle();
});

describe('Activity Analytics SQL builders & date arithmetic', () => {
  const tz = 'Asia/Taipei';
  // Fixed timestamp: 2026-11-14T10:00:00+08:00 (UTC: 2026-11-14T02:00:00Z)
  const fixedNow = Date.parse('2026-11-14T02:00:00Z');

  it('calendarMonthBounds generates 3 calendar month boundaries in region timezone', () => {
    const bounds = calendarMonthBounds(tz, 3, fixedNow);
    expect(bounds).toHaveLength(3);
    expect(bounds.map((b) => b.label)).toEqual(['2026-09', '2026-10', '2026-11']);
    // 2026-09 starts at 2026-08-31T16:00:00.000Z (midnight Sept 1 in Taipei)
    expect(bounds[0].start).toBe('2026-08-31T16:00:00.000Z');
    expect(bounds[0].end).toBe('2026-09-30T16:00:00.000Z');
    expect(bounds[1].start).toBe('2026-09-30T16:00:00.000Z');
    expect(bounds[1].end).toBe('2026-10-31T16:00:00.000Z');
    expect(bounds[2].start).toBe('2026-10-31T16:00:00.000Z');
    expect(bounds[2].end).toBe('2026-11-30T16:00:00.000Z');
  });

  it('dauSql buckets by the day in the time zone of the region and COUNT(DISTINCT blob2)', () => {
    const buckets = new SeriesBuckets(tz, 3, fixedNow);
    const bounds = buckets.bounds();
    const sql = dauSql(bounds, tz, 'TW');

    expect(sql).toContain(`SELECT formatDateTime(timestamp, '%Y-%m-%d', '${tz}') AS bucket, COUNT(DISTINCT blob2) AS dau`);
    expect(sql).not.toContain('CASE');
    expect(sql).toContain("blob1 = 'TW'");
    expect(sql).toContain('GROUP BY bucket FORMAT JSON');
  });

  it('dauSql handles all regions when regionCode is null or omitted', () => {
    const buckets = new SeriesBuckets(tz, 2, fixedNow);
    const sql = dauSql(buckets.bounds(), tz, null);
    expect(sql).not.toContain('blob1 =');
    expect(sql).toContain('COUNT(DISTINCT blob2) AS dau');
  });

  it('mauSql buckets by the month in the time zone of the region and COUNT(DISTINCT blob2)', () => {
    const bounds = calendarMonthBounds(tz, 3, fixedNow);
    const sql = mauSql(bounds, tz, 'TW');

    expect(sql).toContain(`SELECT formatDateTime(timestamp, '%Y-%m', '${tz}') AS month, COUNT(DISTINCT blob2) AS mau`);
    expect(sql).not.toContain('CASE');
    expect(sql).toContain("blob1 = 'TW'");
    expect(sql).toContain('GROUP BY month FORMAT JSON');
  });

  it('rollingActiveSql generates window query for distinct users', () => {
    const sql = rollingActiveSql('2026-10-15T16:00:00.000Z', '2026-11-14T16:00:00.000Z', 'TW');
    expect(sql).toContain("timestamp >= toDateTime('2026-10-15 16:00:00')");
    expect(sql).toContain("timestamp < toDateTime('2026-11-14 16:00:00')");
    expect(sql).toContain("blob1 = 'TW'");
    expect(sql).toContain('COUNT(DISTINCT blob2) AS active_users');
    expect(sql).toContain('FORMAT JSON');
  });
});

describe('activeUserAnalytics reader service', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns available: false when CF credentials are not configured', async () => {
    const testEnv = { ...env, CF_ACCOUNT_ID: undefined, CF_ANALYTICS_TOKEN: undefined };
    const result = await activeUserAnalytics(testEnv as any, { regionCode: 'TW' });
    expect(result).toEqual({ available: false });
  });

  it('returns available: false when the SQL API fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('Error', { status: 500 }));
    const testEnv = { ...env, CF_ACCOUNT_ID: 'acc123', CF_ANALYTICS_TOKEN: 'tok123' };
    const result = await activeUserAnalytics(testEnv as any, { regionCode: 'TW' });
    expect(result).toEqual({ available: false });
  });

  it('computes metrics and stickiness when SQL API responds successfully', async () => {
    const fixedNow = Date.parse('2026-11-14T02:00:00Z');
    globalThis.fetch = vi.fn().mockImplementation(async (_req, init) => {
      const body = String(init?.body ?? '');
      if (body.includes('AS dau')) {
        return new Response(
          JSON.stringify({
            data: [
              { bucket: '2026-11-13', dau: 10 },
              { bucket: '2026-11-14', dau: 20 },
            ],
          }),
        );
      }
      if (body.includes('AS mau')) {
        return new Response(
          JSON.stringify({
            data: [
              { month: '2026-09', mau: 50 },
              { month: '2026-10', mau: 80 },
              { month: '2026-11', mau: 100 },
            ],
          }),
        );
      }
      if (body.includes('AS active_users')) {
        // Distinguish 7d vs 30d by checking timestamp in query
        if (body.includes('2026-11-07') || body.includes('2026-11-06')) {
          return new Response(JSON.stringify({ data: [{ active_users: 35 }] }));
        }
        return new Response(JSON.stringify({ data: [{ active_users: 60 }] }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });

    const testEnv = { ...env, CF_ACCOUNT_ID: 'acc123', CF_ANALYTICS_TOKEN: 'tok123' };
    const result = await activeUserAnalytics(testEnv as any, { regionCode: 'TW', days: 30 }, fixedNow);

    expect(result.available).toBe(true);
    if (!result.available) return;

    expect(result.today_dau).toBe(20);
    expect(result.mau_series).toHaveLength(3);
    expect(result.mau_series.find((m) => m.month === '2026-11')?.mau).toBe(100);
    expect(result.active_30d).toBe(60);
    // Average DAU over 30 days: (10 + 20) / 30 = 1.0. Stickiness = 1 / 60 = 0.0167
    expect(result.stickiness).toBeCloseTo(1 / 60, 3);
  });
});

describe('Activity tracking middleware write rules & throttle', () => {
  it('shouldRecordActivity filters out admin, refresh, and chat endpoints', () => {
    // Admin routes must not be recorded
    expect(shouldRecordActivity('/api/v1/admin/stats/overview')).toBe(false);
    expect(shouldRecordActivity('/api/v1/admin/users')).toBe(false);

    // Refresh routes must not be recorded
    expect(shouldRecordActivity('/api/v1/auth/refresh')).toBe(false);
    expect(shouldRecordActivity('/auth/refresh')).toBe(false);

    // Chat / hub routes must not be recorded
    expect(shouldRecordActivity('/api/chat/hub')).toBe(false);
    expect(shouldRecordActivity('/api/chat/hub/snapshot')).toBe(false);
    expect(shouldRecordActivity('/api/chat/rooms/123/messages')).toBe(false);

    // Normal consumer API routes must be recorded
    expect(shouldRecordActivity('/api/v1/listings')).toBe(true);
    expect(shouldRecordActivity('/api/v1/orders')).toBe(true);
    expect(shouldRecordActivity('/api/v1/auth/me')).toBe(true);
    expect(shouldRecordActivity('/api/v1/messaging/conversations')).toBe(true);
  });

  it('records user activity via writeDataPoint with indexes: [userId], blobs: [region, userId]', async () => {
    await seedReference();
    const userId = await createUser('activity-user-1@ntu.edu.tw');
    const token = await signToken('access', { user_id: userId }, env);
    const writeDataPoint = vi.fn();
    const ACTIVITY_EVENTS = { writeDataPoint };

    // Valid authenticated call to /api/v1/auth/me
    const res = await call('/api/v1/auth/me', {
      method: 'GET',
      token,
      headers: { 'X-Region': 'TW' },
      env: { ACTIVITY_EVENTS: ACTIVITY_EVENTS as any },
    });
    expect(res.status).toBe(200);

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const [callArgs] = writeDataPoint.mock.calls[0];
    expect(callArgs.indexes).toEqual([userId]);
    expect(callArgs.blobs).toEqual(['TW', userId]);
    expect(callArgs.doubles).toEqual([1]);
  });

  it('throttles writes to at most once per 5 minutes per user', async () => {
    await seedReference();
    const userId = await createUser('activity-user-throttle@ntu.edu.tw');
    const token = await signToken('access', { user_id: userId }, env);
    const writeDataPoint = vi.fn();
    const ACTIVITY_EVENTS = { writeDataPoint };

    // First call records
    await call('/api/v1/auth/me', {
      token,
      env: { ACTIVITY_EVENTS: ACTIVITY_EVENTS as any },
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);

    // Second immediate call is throttled
    await call('/api/v1/auth/me', {
      token,
      env: { ACTIVITY_EVENTS: ACTIVITY_EVENTS as any },
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);

    // Different user records independently
    const user2Id = await createUser('activity-user-throttle-2@ntu.edu.tw');
    const token2 = await signToken('access', { user_id: user2Id }, env);
    await call('/api/v1/auth/me', {
      token: token2,
      env: { ACTIVITY_EVENTS: ACTIVITY_EVENTS as any },
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(2);
  });

  it('does not record for unauthenticated requests', async () => {
    const writeDataPoint = vi.fn();
    const ACTIVITY_EVENTS = { writeDataPoint };

    await call('/api/v1/promotions/current', {
      env: { ACTIVITY_EVENTS: ACTIVITY_EVENTS as any },
    });
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('never throws into the request if writeDataPoint throws or binding is absent', async () => {
    await seedReference();
    const userId = await createUser('activity-user-err@ntu.edu.tw');
    const token = await signToken('access', { user_id: userId }, env);

    // 1. writeDataPoint throws
    const throwingDataset = {
      writeDataPoint: vi.fn().mockImplementation(() => {
        throw new Error('Analytics Engine write failure');
      }),
    };
    const res1 = await call('/api/v1/auth/me', {
      token,
      env: { ACTIVITY_EVENTS: throwingDataset as any },
    });
    expect(res1.status).toBe(200);

    // 2. binding is undefined
    const res2 = await call('/api/v1/auth/me', {
      token,
      env: { ACTIVITY_EVENTS: undefined },
    });
    expect(res2.status).toBe(200);
  });
});

describe('GET /api/v1/admin/stats/active-users endpoint', () => {
  it('requires staff authentication (403 for regular user)', async () => {
    await seedReference();
    const regularId = await createUser('regular-user@ntu.edu.tw');
    const regularToken = await signToken('access', { user_id: regularId }, env);

    const res = await call('/api/v1/admin/stats/active-users?region=TW', {
      token: regularToken,
    });
    expect(res.status).toBe(403);
  });

  it('answers 200 with available: false when CF credentials are not configured', async () => {
    await seedReference();
    const admin = await staff('admin-active@ntu.edu.tw', { admin: true });
    const res = await call('/api/v1/admin/stats/active-users?region=TW', {
      token: admin.token,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toEqual({ available: false });
  });

  it('enforces region scoping: 403 when staff accesses unmanaged region', async () => {
    await seedReference();
    const staffUser = await staff('regional-staff@ntu.edu.tw', { regions: ['TW'] });

    // Allowed region
    const resOk = await call('/api/v1/admin/stats/active-users?region=TW', {
      token: staffUser.token,
    });
    expect(resOk.status).toBe(200);

    // Forbidden region
    const resForbidden = await call('/api/v1/admin/stats/active-users?region=HK', {
      token: staffUser.token,
    });
    expect(resForbidden.status).toBe(403);

    // Regional staff cannot omit region (all regions is admin-only)
    const resAllForbidden = await call('/api/v1/admin/stats/active-users', {
      token: staffUser.token,
    });
    expect(resAllForbidden.status).toBe(403);
  });

  it('rejects invalid days parameter with 400', async () => {
    await seedReference();
    const admin = await staff('admin-active-days@ntu.edu.tw', { admin: true });

    const resNegative = await call('/api/v1/admin/stats/active-users?region=TW&days=-5', {
      token: admin.token,
    });
    expect(resNegative.status).toBe(400);

    const resTooLarge = await call('/api/v1/admin/stats/active-users?region=TW&days=100', {
      token: admin.token,
    });
    expect(resTooLarge.status).toBe(400);

    const resNotNumber = await call('/api/v1/admin/stats/active-users?region=TW&days=abc', {
      token: admin.token,
    });
    expect(resNotNumber.status).toBe(400);
  });
});
