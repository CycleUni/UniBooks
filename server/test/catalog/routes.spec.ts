import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppEnv } from '../../src/env';
import { errorHandler } from '../../src/middleware/error';
import { signToken } from '../../src/lib/jwt';
import { bookRoutes } from '../../src/routes/books';
import { listingRoutes } from '../../src/routes/listings';
import { searchRoutes } from '../../src/routes/search';
import { subscriptionRoutes } from '../../src/routes/subscriptions';
import { sitemapRoutes } from '../../src/routes/sitemap';

// Mounted with a trailing slash so a router's '/' is '/api/v1/<x>'
// (Hono's mergePath drops the slash when the mount has none).
const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/api/v1/books', bookRoutes);
app.route('/api/v1/listings', listingRoutes);
app.route('/api/v1/search', searchRoutes);
app.route('/api/v1/subscriptions', subscriptionRoutes);
app.route('/api/v1', sitemapRoutes);

const ORIGIN = 'http://x';
const fetchApi = async (path: string, init?: RequestInit) => app.fetch(new Request(`${ORIGIN}${path}`, init), env);
const hex = 'a'.repeat(32);

describe('auth and upload-token gates', () => {
  it('requires sign-in for writes', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/books/manual'],
      ['POST', '/api/v1/listings'],
      ['POST', '/api/v1/listings/uploads'],
      ['GET', '/api/v1/subscriptions'],
      ['DELETE', '/api/v1/subscriptions'],
    ] as const) {
      const res = await fetchApi(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses upload PUTs without a valid upload token, or with the wrong action', async () => {
    let res = await fetchApi('/api/v1/listings/uploads/file?token=bad', { method: 'PUT', body: 'x' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'upload.errTokenInvalid' } });
    const token = await signToken(
      'upload',
      { user_id: 'u1', action: 'avatar', target_key: `tmp/listings/u1/${hex}.jpg`, content_type: 'image/jpeg', max_bytes: 100 },
      env,
    );
    res = await fetchApi(`/api/v1/listings/uploads/file?token=${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect(res.status).toBe(403);
  });

  it('stores only bytes matching the token, once', async () => {
    const key = `tmp/listings/u9/${'b'.repeat(32)}.jpg`;
    const token = await signToken(
      'upload',
      { user_id: 'u9', action: 'listing_photo', target_key: key, content_type: 'image/jpeg', max_bytes: 16 },
      env,
    );
    const put = (body: Uint8Array, type = 'image/jpeg') =>
      fetchApi(`/api/v1/listings/uploads/file?token=${token}`, { method: 'PUT', headers: { 'Content-Type': type }, body });
    expect((await put(new TextEncoder().encode('<html></html>'))).status).toBe(400); // not a JPEG
    expect((await put(new Uint8Array([0xff, 0xd8, 0xff]), 'text/html')).status).toBe(400); // wrong type
    expect((await put(new Uint8Array(32).fill(0xff))).status).toBe(400); // over max_bytes
    expect((await put(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).status).toBe(200);
    expect((await env.R2.get(key))?.httpMetadata?.contentType).toBe('image/jpeg');
    expect((await put(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]))).status).toBe(409); // no overwrite
  });
});

describe('sitemap routing', () => {
  it('404s section names outside the section pattern', async () => {
    for (const f of ['books-tw-0.xml', 'users-tw-1.xml', 'books-TW-1.xml', 'books-tw-1.json']) {
      expect((await fetchApi(`/api/v1/sitemap/${f}`)).status, f).toBe(404);
    }
  });
});
