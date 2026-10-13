import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCover } from '../../src/services/frontend/cover';

/**
 * services/frontend/cover.ts (the /api/cover proxy), run against a stubbed
 * fetch and edge cache.
 * What matters is how long each answer is kept: a cover for a year, a
 * missing cover for a day, and an upstream failure for ten seconds — short,
 * but not zero, or every page asking while the upstream is down re-runs it.
 */
describe('/api/cover caching', () => {
  let stored: Map<string, Response>;
  let pending: Promise<unknown>[];
  let cache: Pick<Cache, 'match' | 'put'>;

  beforeEach(() => {
    stored = new Map();
    pending = [];
    cache = {
      match: vi.fn(async (req: RequestInfo | URL) => stored.get(new Request(req).url)?.clone()),
      put: vi.fn(async (req: RequestInfo | URL, res: Response) => {
        stored.set(new Request(req).url, res);
      }),
    } as unknown as Pick<Cache, 'match' | 'put'>;
  });

  async function get(
    src: string,
    fetchMock: (url: string) => Promise<Response>,
    extra = '',
    onMiss?: () => Promise<void>,
  ): Promise<Response> {
    const request = new Request(`https://unibooks.app/api/cover?src=${encodeURIComponent(src)}${extra}`);
    const response = await handleCover(request, {
      cache,
      fetch: fetchMock,
      waitUntil: (p) => {
        pending.push(p);
      },
      onMiss,
    });
    await Promise.all(pending);
    return response;
  }

  const OL = 'https://covers.openlibrary.org/b/isbn/9786263241893-L.jpg';
  const image = () => new Response(new Uint8Array(5000), { status: 200, headers: { 'content-type': 'image/jpeg' } });

  it('keeps a found cover for a year', async () => {
    const res = await get(OL, async () => image());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(stored.size).toBe(1);
  });

  it('keeps "no cover" for a day, and asks Open Library for a real 404', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(null, { status: 404 }));
    const res = await get(OL, fetchMock);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('default')).toBe('false');
  });

  it('holds an upstream failure for ten seconds instead of caching it as missing', async () => {
    const res = await get(OL, async () => {
      throw new Error('network down');
    });
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
    expect(stored.size).toBe(1);
  });

  it('treats an upstream 5xx from Google as a failure too', async () => {
    const res = await get(
      'https://books.google.com/books/content?id=X&printsec=frontcover&img=1&zoom=3',
      async () => new Response(null, { status: 503 }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
  });

  it('skips Google placeholders and falls back to a lower zoom', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new URL(url).searchParams.get('zoom') === '2'
        ? new Response(new Uint8Array(15000), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=30' } })
        : new Response(new Uint8Array(5000), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' } }),
    );
    const res = await get('https://books.google.com/books/content?id=X&printsec=frontcover&img=1&zoom=2', fetchMock);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses hosts outside the allowlist without fetching them', async () => {
    const fetchMock = vi.fn(async () => image());
    for (const src of ['https://evil.example/x.jpg', 'file:///etc/passwd', 'not a url']) {
      const res = await get(src, fetchMock);
      expect(res.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never serves an upstream that answered with something other than an image', async () => {
    const page = '<html><script>alert(1)</script></html>'.padEnd(5000, ' ');
    const res = await get(OL, async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(res.status).toBe(404);
  });

  it('sends a found cover with nosniff and a locked-down CSP', async () => {
    const res = await get(OL, async () => image());
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('caches by src alone, so an extra parameter cannot force a fresh fetch', async () => {
    const fetchMock = vi.fn(async () => image());
    await get(OL, fetchMock, '&ngsw-bypass=');
    await get(OL, fetchMock, '&x=123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs the miss hook (the rate limit) only when the edge cache misses', async () => {
    const onMiss = vi.fn(async () => {});
    await get(
      OL,
      vi.fn(async () => image()),
      '',
      onMiss,
    );
    await get(
      OL,
      vi.fn(async () => image()),
      '',
      onMiss,
    );
    expect(onMiss).toHaveBeenCalledTimes(1);
  });

  it('does not buffer an upstream body larger than any cover', async () => {
    const huge = new Response(new Uint8Array(6 * 1024 * 1024), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    const res = await get(
      OL,
      vi.fn(async () => huge),
    );
    expect(res.status).toBe(404);
  });

  it('serves a repeat request from the edge cache without going upstream', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    await get(OL, fetchMock);
    await get(OL, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
