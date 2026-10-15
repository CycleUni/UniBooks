import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, seedReference } from '../accounts/helpers';
import { staff } from '../ads/helpers';

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

  it('keeps an answer for a version this location has not seen out of every cache', async () => {
    const res = await call(`${METADATA}&v=notyet`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('a failed write names no version', async () => {
    const res = await call('/api/v1/admin/categories', { token: root.token, body: { title: 'No slug', region: 'TW' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('X-Cache-Version')).toBeNull();
  });
});
