import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, seedReference, staff } from '../ads/helpers';
import { call as callWorker } from '../accounts/helpers';
import { isbnChecksumOk } from '../../src/services/catalog/isbn';
import { probeGoogleBooks, probeIsbnnet, probeOpenLibrary, randomProbeIsbn } from '../../src/services/catalog/lookups';

let root: { id: string; token: string };
let manager: { id: string; token: string };

beforeAll(async () => {
  await seedReference();
  root = await staff('health-root@example.com', { admin: true });
  manager = await staff('health-tw@example.com', { regions: ['TW'] });
});

afterEach(() => vi.restoreAllMocks());

/** Where lib/cache.ts storePut keeps the external snapshot. */
const SNAPSHOT = new Request(`https://cache.internal/${encodeURIComponent('health:external:v1')}`);
beforeEach(() => caches.default.delete(SNAPSHOT));
const health = async () => (await (await call('/api/v1/admin/system/health', { token: root.token })).json()) as any;

const upstream = (google: number, openLibrary: number) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://www.googleapis.com/books/')) return new Response('{}', { status: google });
    if (url.startsWith('https://openlibrary.org/')) return new Response('{}', { status: openLibrary });
    throw new Error(`unexpected fetch ${url}`);
  });

describe('admin system health', () => {
  it('is for superusers only', async () => {
    upstream(200, 200);
    expect((await call('/api/v1/admin/system/health', { token: manager.token })).status).toBe(403);
    expect((await call('/api/v1/admin/system/health')).status).toBe(401);
  });

  it('reports core and external checks', async () => {
    upstream(200, 200);
    const res = await call('/api/v1/admin/system/health', { token: root.token });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.checks.map((c: any) => [c.name, c.group, c.status])).toEqual([
      ['database', 'core', 'ok'],
      ['cache', 'core', 'ok'],
      ['migrations', 'core', 'ok'],
      ['google_books', 'external', 'ok'],
      ['open_library', 'external', 'ok'],
      // The stub resolver (vitest.config.ts) answers not_found: it is up.
      ['isbnnet', 'external', 'ok'],
    ]);
    expect(body.checks[3].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('takes the worst check as the overall status', async () => {
    upstream(429, 500);
    const body = (await (await call('/api/v1/admin/system/health', { token: root.token })).json()) as any;
    expect(body.status).toBe('error');
    const byName = Object.fromEntries(body.checks.map((c: any) => [c.name, c]));
    expect(byName.google_books).toMatchObject({ status: 'degraded', detail: 'rate_limited' });
    expect(byName.open_library).toMatchObject({ status: 'error', detail: 'http_500' });
  });

  it('caches external results for 5 minutes while all answer, and records when', async () => {
    const spy = upstream(200, 200);
    const first = await health();
    expect(first.external_cached).toBe(false);
    expect((await caches.default.match(SNAPSHOT))?.headers.get('Cache-Control')).toBe('public, max-age=300');
    const calls = spy.mock.calls.length;

    const second = await health();
    expect(second.external_cached).toBe(true);
    expect(second.external_checked_at).toBe(first.external_checked_at);
    expect(spy.mock.calls.length).toBe(calls);
    // The core checks still run on every request.
    expect(Date.parse(second.checked_at)).toBeGreaterThanOrEqual(Date.parse(first.external_checked_at));
  });

  it('caches for only 30 seconds once a source fails', async () => {
    upstream(200, 503);
    expect((await health()).status).toBe('error');
    expect((await caches.default.match(SNAPSHOT))?.headers.get('Cache-Control')).toBe('public, max-age=30');
  });

  it('keeps external outages off the public healthz', async () => {
    upstream(500, 500);
    const res = await callWorker('/api/v1/core/healthz');
    expect(res.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('upstream probes', () => {
  it('makes a fresh valid ISBN each time', () => {
    for (let i = 0; i < 50; i++) {
      const isbn = randomProbeIsbn();
      expect(isbn).toMatch(/^978626\d{7}$/);
      expect(isbnChecksumOk(isbn)).toBe(true);
    }
  });

  it('tells a down library site from a down resolver', async () => {
    const withResolver = (lookup: () => Promise<unknown>) =>
      ({ ...env, ISBNNET: { lookup }, ISBNNET_RESOLVER_URL: undefined }) as unknown as typeof env;
    expect(await probeIsbnnet(withResolver(async () => ({ status: 'upstream_error' })))).toMatchObject({
      status: 'degraded',
      detail: 'upstream_error',
    });
    expect(
      await probeIsbnnet(
        withResolver(async () => {
          throw new Error('no worker');
        }),
      ),
    ).toMatchObject({ status: 'error', detail: 'unreachable' });
    const none = { ...env, ISBNNET: undefined, ISBNNET_RESOLVER_URL: undefined } as unknown as typeof env;
    expect(await probeIsbnnet(none)).toMatchObject({ status: 'error', detail: 'not_configured' });
  });

  it('reports a timeout and a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('slow', 'TimeoutError'));
    expect(await probeOpenLibrary(env)).toMatchObject({ status: 'error', detail: 'timeout' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network'));
    expect(await probeGoogleBooks(env)).toMatchObject({ status: 'error', detail: 'unreachable' });
  });
});
