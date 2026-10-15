import { describe, expect, it, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
const get = (path: string) => worker.fetch(new Request(`http://x${path}`));
const cacheKeys = async () =>
  (await env.KV.list({ prefix: 'c:' })).keys.map((k) => k.name).concat((await env.KV.list({ prefix: 'ads:' })).keys.map((k) => k.name));

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO currencies (code, symbol, decimal_places) VALUES ('TWD', 'NT$', 0)"),
    env.DB.prepare("INSERT OR IGNORE INTO languages (code, name) VALUES ('zh-TW', 'Chinese (Taiwan)')"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO regions (code, name, default_currency, default_language, timezone, languages, is_active, created_at) VALUES ('TW', 'Taiwan', 'TWD', 'zh-TW', 'Asia/Taipei', '[\"zh-TW\"]', 1, '2026-01-01T00:00:00Z')",
    ),
  ]);
});

describe('public caches never key on unvalidated input', () => {
  it('unknown ad positions and schools answer empty without a cache entry', async () => {
    const before = (await cacheKeys()).length;
    for (const q of ['position=nope-1', 'position=nope-2', 'school=zzz-1', 'school=zzz-2']) {
      const res = await get(`/api/v1/promotions/active?region=tw&${q}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { count: number }).count).toBe(0);
    }
    expect((await cacheKeys()).length).toBe(before);
  });

  it('the most-wanted list for unknown schools mints no cache entry', async () => {
    const before = (await cacheKeys()).length;
    for (const s of ['aaa', 'bbb', 'ccc']) {
      const res = await get(`/api/v1/listings/recent-books?region=tw&school=${s}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { waitlist: unknown[] }).waitlist).toEqual([]);
    }
    expect((await cacheKeys()).length).toBe(before);
  });
});

describe('browser caching of viewer-independent answers', () => {
  it('needs no Vary when the URL names region and language', async () => {
    for (const path of ['/api/v1/core/regions?region=tw&lang=zh-TW', '/api/v1/core/metadata?region=tw&lang=zh-TW']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, stale-while-revalidate=\d+$/);
      expect(res.headers.get('Vary')).toBeNull();
    }
  });

  it('keeps varying on the fallbacks when the URL leaves them out', async () => {
    expect((await get('/api/v1/core/metadata?region=tw')).headers.get('Vary')).toBe('Accept-Language, X-Region, Cookie');
    expect((await get('/api/v1/core/regions?lang=zh-TW')).headers.get('Vary')).toBe('Accept-Language, X-Region, Cookie');
    expect((await get('/api/v1/core/regions?region=zz&lang=zh-TW')).headers.get('Vary')).toBe('Accept-Language, X-Region, Cookie');
  });
});
