import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { invalidateRegionCache } from '../../src/lib/region';

/**
 * routes/frontend.ts wired into the Worker: /api/cover and /<region>/book,
 * served next to the app (env.ASSETS = test/fixtures/assets, a stand-in for
 * the Angular build). Only an active region's lowercase
 * code is the Worker's; every other /<x>/book is the static app's answer.
 */
const ORIGIN = 'http://unibooks.test';
const CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';

const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
const get = (path: string, ua = BROWSER) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { 'User-Agent': ua, Accept: 'text/html' } }));

describe('frontend routes in the Worker', () => {
  beforeAll(async () => {
    // Raw SQL with the base columns only, so the seed does not depend on
    // columns other modules add to schema.ts before migrations are regenerated.
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO currencies (code, symbol, decimal_places) VALUES ('TWD', 'NT$', 0)"),
      env.DB.prepare("INSERT OR IGNORE INTO languages (code, name) VALUES ('zh-TW', 'Chinese (Taiwan)')"),
      env.DB.prepare(
        "INSERT OR IGNORE INTO regions (code, name, default_currency, default_language, timezone, created_at) VALUES ('TW', 'Taiwan', 'TWD', 'zh-TW', 'Asia/Taipei', ?)",
      ).bind(new Date().toISOString()),
    ]);
    invalidateRegionCache();
  });

  it('answers /api/cover itself, never with the SPA shell', async () => {
    const res = await get('/api/cover');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it("serves an active region's book page from its app shell", async () => {
    const res = await get('/tw/book?isbn=9781449319793');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('lang="zh-TW"');
  });

  it('leaves /<x>/book to the static app when <x> is not an active region', async () => {
    for (const path of ['/zz/book?isbn=9781449319793', '/TW/book?isbn=9781449319793', '/messages/book']) {
      const res = await get(path, CRAWLER);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('text/html');
      // No book lookup ran, so nothing was injected.
      expect(await res.text(), path).not.toContain('og:type" content="book');
    }
  });

  it('keeps unknown /api/ paths as JSON 404s instead of the SPA fallback', async () => {
    const res = await get('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
