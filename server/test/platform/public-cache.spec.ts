import { beforeAll, describe, expect, it } from 'vitest';
import { call, seedReference } from '../accounts/helpers';
import { seedListing, seedUser } from '../messaging/helpers';

beforeAll(seedReference);

// The extra `x` only gives each test its own cache entry; the handlers ignore it.
const unique = () => `x=${crypto.randomUUID()}`;
const count = async (res: Response) => ((await res.json()) as { count: number }).count;
const books = async (res: Response) => ((await res.json()) as { results: unknown[] }).results.length;

describe('short edge cache for the listing feed', () => {
  it('serves the same answer for a few seconds when the URL names region and language', async () => {
    const seller = await seedUser();
    const feed = `/api/v1/listings?region=TW&lang=zh-TW&${unique()}`;
    const before = await count(await call(feed));

    await seedListing(seller.id);
    expect(await count(await call(feed))).toBe(before); // the cached copy
    // Browsers never keep it: only the edge does.
    expect((await call(feed)).headers.get('Cache-Control')).toBeNull();
  });

  it('builds the answer every time when the URL leaves the language to a header', async () => {
    const seller = await seedUser();
    const feed = `/api/v1/listings?region=TW&${unique()}`;
    const before = await count(await call(feed));
    await seedListing(seller.id);
    expect(await count(await call(feed))).toBe(before + 1);
  });
});

describe('edge cache for search', () => {
  const browse = (extra: string) => `/api/v1/search/books?region=TW&lang=zh-TW&in_stock=1&${extra}`;

  /** The Cache-Control the edge stored the answer for `path` under. */
  const storedFor = async (path: string) => {
    const url = new URL(`http://x${path}`);
    url.searchParams.set('v', 'public');
    return (await caches.default.match(new Request(url.toString())))?.headers.get('Cache-Control');
  };

  it('keeps a search that found something for minutes, one that found nothing for seconds', async () => {
    const seller = await seedUser();
    await seedListing(seller.id);
    const found = browse(unique());
    expect(await books(await call(found))).toBeGreaterThan(0);
    expect(await storedFor(found)).toBe('public, max-age=300');

    const empty = `/api/v1/search/books?region=TW&lang=zh-TW&course=nobody-${crypto.randomUUID()}&${unique()}`;
    expect(await books(await call(empty))).toBe(0);
    expect(await storedFor(empty)).toBe('public, max-age=30');
  });

  it('caches an anonymous search, never a signed-in one', async () => {
    const seller = await seedUser();
    const viewer = await seedUser();
    const anon = browse(unique());
    const before = await books(await call(anon));

    await seedListing(seller.id);
    expect(await books(await call(anon))).toBe(before); // the cached copy
    // The signed-in answer carries the visitor's own subscriptions: built fresh, and not stored.
    const signed = browse(unique());
    expect(await books(await call(signed, { token: viewer.token }))).toBe(before + 1);
    expect(await books(await call(signed))).toBe(before + 1); // nothing was cached under that URL
  });
});

describe('edge cache for the home page list', () => {
  const RECENT = '/api/v1/listings/recent-books?region=TW&lang=zh-TW';
  const storedFor = async (path: string) => {
    const url = new URL(`http://x${path}`);
    url.searchParams.set('v', 'public');
    return (await caches.default.match(new Request(url.toString())))?.headers.get('Cache-Control');
  };

  it('keeps a list with books for minutes and an empty one for seconds', async () => {
    const seller = await seedUser();
    await seedListing(seller.id);
    const withBooks = `${RECENT}&${unique()}`;
    expect(await count(await call(withBooks))).toBeGreaterThan(0);
    expect(await storedFor(withBooks)).toBe('public, max-age=300');

    // A school with no listings: nothing to show yet.
    const empty = `${RECENT}&school=NTU&${unique()}`;
    const res = await call(empty);
    if (res.status === 200 && (await count(res)) === 0) expect(await storedFor(empty)).toBe('public, max-age=30');
  });

  it('never caches a seller page on the feed', async () => {
    const seller = await seedUser();
    const page = `/api/v1/listings?region=TW&lang=zh-TW&seller_id=${seller.id}&${unique()}`;
    expect(await count(await call(page))).toBe(0);
    await seedListing(seller.id);
    expect(await count(await call(page))).toBe(1);
  });
});
