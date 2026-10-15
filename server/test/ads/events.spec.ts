import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { ad, advertiser, call, future, past, seedReference, stubAdEvents } from './helpers';
import { adCounts, adCountsSql, regionTotalsSql } from '../../src/services/admin/adAnalytics';

beforeAll(seedReference);

describe('ad view / click events', () => {
  it('writes one data point for a live ad, and none to D1', async () => {
    const live = await ad(await advertiser({ regions: ['TW'] }));
    const AD_EVENTS = stubAdEvents();
    const headers = { 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'test-agent' };
    const view = await call(`/api/v1/promotions/${live}/view`, { method: 'POST', headers, env: { AD_EVENTS: AD_EVENTS as any } });
    expect(view.status).toBe(204);
    const click = await call(`/api/v1/promotions/${live}/click`, { method: 'POST', headers, env: { AD_EVENTS: AD_EVENTS as any } });
    expect(click.status).toBe(204);

    expect(AD_EVENTS.writeDataPoint).toHaveBeenCalledTimes(2);
    const [first] = AD_EVENTS.writeDataPoint.mock.calls[0];
    expect(first.indexes).toEqual([String(live)]);
    expect(first.doubles).toEqual([1]);
    const [event, region, position, hash] = first.blobs;
    expect([event, region, position]).toEqual(['view', 'TW', 'home_banner']);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // Same client, same day: same hash (so uniques can be counted), no IP stored.
    expect(AD_EVENTS.writeDataPoint.mock.calls[1][0].blobs).toEqual(['click', 'TW', 'home_banner', hash]);
    expect(JSON.stringify(first)).not.toContain('203.0.113.7');

    // A different client hashes differently.
    await call(`/api/v1/promotions/${live}/view`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '198.51.100.1', 'User-Agent': 'test-agent' },
      env: { AD_EVENTS: AD_EVENTS as any },
    });
    expect(AD_EVENTS.writeDataPoint.mock.calls[2][0].blobs[3]).not.toBe(hash);
  });

  it('records nothing for an ad that is not live', async () => {
    const adv = await advertiser({ regions: ['TW'] });
    const ids = [
      await ad(adv, { active: false }),
      await ad(adv, { start: past(10), end: past(1) }),
      await ad(adv, { start: future(1), end: future(10) }),
      await ad(await advertiser({ regions: ['TW'], active: false })),
    ];
    const AD_EVENTS = stubAdEvents();
    for (const id of ids) {
      for (const kind of ['view', 'click']) {
        const res = await call(`/api/v1/promotions/${id}/${kind}`, { method: 'POST', env: { AD_EVENTS: AD_EVENTS as any } });
        expect(res.status, `${id} ${kind}`).toBe(204);
      }
    }
    expect(AD_EVENTS.writeDataPoint).not.toHaveBeenCalled();
  });

  it('404s an unknown or malformed id', async () => {
    const AD_EVENTS = stubAdEvents();
    expect((await call('/api/v1/promotions/999999/view', { method: 'POST', env: { AD_EVENTS: AD_EVENTS as any } })).status).toBe(404);
    expect((await call('/api/v1/promotions/abc/click', { method: 'POST', env: { AD_EVENTS: AD_EVENTS as any } })).status).toBe(404);
    expect(AD_EVENTS.writeDataPoint).not.toHaveBeenCalled();
  });

  it('works without the binding (local dev)', async () => {
    const live = await ad(await advertiser({ allRegions: true }));
    expect((await call(`/api/v1/promotions/${live}/view`, { method: 'POST', env: { AD_EVENTS: undefined } })).status).toBe(204);
  });
});

describe('public active list', () => {
  it('returns live ads for the region in the shape the app reads', async () => {
    const adv = await advertiser({ name: 'Bookshop', regions: ['HK'] });
    const live = await ad(adv, { title: 'HK only' });
    await ad(adv, { title: 'Off', active: false });
    const res = await call('/api/v1/promotions/active?position=home_banner', { headers: { 'X-Region': 'HK' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; results: Record<string, unknown>[] };
    const mine = body.results.filter((r) => r.advertiser_name === 'Bookshop');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({
      id: live,
      title: 'HK only',
      image_url: 'https://cdn.example.com/a.png',
      target_url: 'https://shop.example.com/',
      position: 'home_banner',
      headline: '',
      subheadline: '',
      slot_index: 1,
      advertiser_name: 'Bookshop',
      labels: ['new'],
      show_in_hero: false,
    });
    expect(body).toHaveProperty('count');

    const tw = (await (await call('/api/v1/promotions/active?position=home_banner', { headers: { 'X-Region': 'TW' } })).json()) as {
      results: { advertiser_name: string }[];
    };
    expect(tw.results.some((r) => r.advertiser_name === 'Bookshop')).toBe(false);
  });
});

describe('admin ad analytics', () => {
  it('returns zeros and available=false without SQL API credentials', async () => {
    const res = await adCounts({ ...env, CF_ACCOUNT_ID: undefined, CF_ANALYTICS_TOKEN: undefined }, [1, 2]);
    expect(res.available).toBe(false);
    expect(res.counts.get(1)).toEqual({ views: 0, clicks: 0, uniqueViews: 0, uniqueClicks: 0 });
  });

  it('builds one query per page with only integer ids and safe region codes', () => {
    const q = adCountsSql([3, 1]);
    expect(q).toContain("index1 IN ('3', '1')");
    expect(q).toContain('SUM(_sample_interval)');
    expect(q).toContain('COUNT(DISTINCT blob4)');
    expect(q).toContain('FROM unibooks_ad_events');
    expect(regionTotalsSql("TW' OR 1=1 --", null)).toBeNull();
    expect(regionTotalsSql('TW', '2026-10-05T16:00:00.000Z')).toContain("timestamp >= toDateTime('2026-10-05 16:00:00')");
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reads a page of ads in one SQL API call, then from KV', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        data: [
          { ad: '41', event: 'view', n: '120', u: '30' },
          { ad: '41', event: 'click', n: 7, u: 5 },
          { ad: '42', event: 'view', n: '3', u: '1' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const e = { ...env, CF_ACCOUNT_ID: 'acct', CF_ANALYTICS_TOKEN: 'tok' };
    const res = await adCounts(e, [41, 42, 43]);
    expect(res.available).toBe(true);
    expect(res.counts.get(41)).toEqual({ views: 120, clicks: 7, uniqueViews: 30, uniqueClicks: 5 });
    expect(res.counts.get(42)).toEqual({ views: 3, clicks: 0, uniqueViews: 1, uniqueClicks: 0 });
    expect(res.counts.get(43)).toEqual({ views: 0, clicks: 0, uniqueViews: 0, uniqueClicks: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(String(init.body)).toContain("index1 IN ('41', '42', '43')");

    await adCounts(e, [43, 42, 41]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable (and caches nothing) when the SQL API fails', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const e = { ...env, CF_ACCOUNT_ID: 'acct', CF_ANALYTICS_TOKEN: 'tok' };
    expect((await adCounts(e, [77])).available).toBe(false);
    expect((await adCounts(e, [77])).available).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
