import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, seedReference } from '../accounts/helpers';
import { ad, advertiser, staff } from '../ads/helpers';
import { ADS_VERSION_KEY, bumpVersion } from '../../src/services/admin/adCache';

let root: { id: string; token: string };

beforeAll(async () => {
  await seedReference();
  root = await staff('edge-root@example.com', { admin: true });
});

const METADATA = '/api/v1/core/metadata?region=TW&lang=zh-TW';
const slugs = async (res: Response) => ((await res.json()) as { categories: { slug: string }[] }).categories.map((c) => c.slug);

describe('versioned edge cache for public lists', () => {
  it('serves the cached copy until a write names a new version, then the fresh one', async () => {
    await call(METADATA);
    // Written behind the cache's back: the cached copy stays.
    await env.DB.prepare(
      "INSERT INTO categories (slug, title, description, sort_order, is_active, translations, region_code) VALUES ('edge-raw', 'Raw', '', 0, 1, '{}', 'TW')",
    ).run();
    expect(await slugs(await call(METADATA))).not.toContain('edge-raw');

    const write = await call('/api/v1/admin/categories', { token: root.token, body: { slug: 'edge-new', title: 'New', region: 'TW' } });
    expect(write.status).toBe(201);
    const header = write.headers.get('X-Cache-Version') ?? '';
    expect(header).toMatch(/^ref=\w+, search=\w+$/);
    const ref = /ref=(\w+)/.exec(header)![1];

    const fresh = await call(`${METADATA}&v=${ref}`);
    expect(fresh.headers.get('Cache-Control')).toMatch(/^public, max-age=/);
    expect(await slugs(fresh)).toEqual(expect.arrayContaining(['edge-raw', 'edge-new']));
    // The URL without ?v= moves to the new version too.
    expect(await slugs(await call(METADATA))).toContain('edge-new');
  });

  it('keeps an answer for a recent version this location has not seen out of every cache', async () => {
    const res = await call(`${METADATA}&v=${Date.now().toString(36)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers a ?v= no recent write could have reported from the cache', async () => {
    for (const v of ['notyet', (Date.now() - 60 * 60_000).toString(36), (Date.now() + 60 * 60_000).toString(36), 'x'.repeat(40)]) {
      const res = await call(`${METADATA}&v=${v}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toMatch(/^public, max-age=/);
    }
  });

  it('a failed write names no version', async () => {
    const res = await call('/api/v1/admin/categories', { token: root.token, body: { title: 'No slug', region: 'TW' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('X-Cache-Version')).toBeNull();
  });
});

describe('edge cache for the public ad list', () => {
  const ACTIVE = '/api/v1/promotions/active?region=TW&position=home_banner';
  const titles = async (res: Response) => ((await res.json()) as { results: { title: string }[] }).results.map((a) => a.title);

  it('keeps the list at the edge until the ads version moves, never in the browser', async () => {
    const adv = await advertiser({ allRegions: true });
    await ad(adv, { title: 'Edge first' });
    const first = await call(ACTIVE);
    expect(first.headers.get('Cache-Control')).toBeNull();
    expect(await titles(first)).toContain('Edge first');

    await ad(adv, { title: 'Edge second' });
    const cachedRes = await call(ACTIVE);
    expect(cachedRes.headers.get('Cache-Control')).toBeNull();
    expect(await titles(cachedRes)).not.toContain('Edge second');

    await bumpVersion(env.KV, ADS_VERSION_KEY);
    expect(await titles(await call(ACTIVE))).toContain('Edge second');
  });
});
