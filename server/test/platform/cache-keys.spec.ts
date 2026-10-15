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

  it('metadata for any number of unknown schools shares one cache entry', async () => {
    for (const s of ['aaa', 'bbb', 'ccc']) expect((await get(`/api/v1/core/metadata?region=tw&school=${s}`)).status).toBe(200);
    const meta = (await cacheKeys()).filter((k) => k.includes('metadata:TW'));
    expect(meta.filter((k) => k.endsWith(':unknown'))).toHaveLength(1);
    expect(meta.some((k) => /aaa|bbb|ccc/.test(k))).toBe(false);
  });
});
