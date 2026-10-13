import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  categories,
  chatReports,
  conversations,
  createDb,
  listings,
  orders,
  regionVerifications,
  reports,
  reviews,
  schools,
  subscriptions,
  users,
  books,
} from '../../src/db';
import { call, seedReference, staff } from '../ads/helpers';

/**
 * Characterization of /admin/stats/*: a fixed data set at a fixed instant, every endpoint
 * with several parameter sets, snapshotted. The aggregation moved from JS into SQL without
 * changing a byte of any answer; these snapshots are what says so.
 */
const NOW = Date.parse('2026-10-12T03:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

/** Deterministic pseudo-random numbers, so the data set is the same on every run. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let root: { id: string; token: string };
const bookIds: string[] = [];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await seedReference();
  root = await staff('stats-root@example.com', { superuser: true });
  const db = createDb(env.DB);
  const rnd = prng(7);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const t = (id: string, hours: number) => ({ id, createdAt: ago(hours), updatedAt: ago(hours) });

  await db.insert(schools).values([
    {
      id: 3,
      regionCode: 'TW',
      code: 'NCKU',
      name: 'National Cheng Kung University',
      emailDomain: 'ncku.edu.tw',
      translations: '{"zh-TW":{"name":"成大"}}',
      createdAt: ago(9000),
    },
    {
      id: 4,
      regionCode: 'TW',
      code: 'NTHU',
      name: 'National Tsing Hua University',
      emailDomain: 'nthu.edu.tw',
      translations: '{}',
      createdAt: ago(9000),
    },
  ]);
  await db.insert(categories).values([
    { id: 11, regionCode: 'TW', slug: 'eng', title: 'Engineering', translations: '{"zh-TW":{"title":"工學院"}}' },
    { id: 12, regionCode: 'TW', slug: 'sci', title: 'Science' },
  ]);

  const userIds: string[] = [];
  for (let i = 0; i < 14; i++) {
    const id = `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    userIds.push(id);
    const hours = Math.floor(rnd() * 6000);
    await db.insert(users).values({
      id,
      email: `stat${i}@example.com`,
      name: `Stat ${i}`,
      deletedAt: i === 13 ? ago(5) : null,
      createdAt: ago(hours),
      updatedAt: ago(hours),
    });
    // Users 11 and 12 verified but inactive; 13 deleted; everyone else counts.
    await db.insert(regionVerifications).values({
      userId: id,
      regionCode: 'TW',
      schoolId: pick([1, 3, 4]),
      verifiedAt: ago(hours),
      isActive: i === 11 || i === 12 ? 0 : 1,
    });
  }

  const titles = ['Calculus', 'Linear Algebra', 'Physics', 'Chemistry', 'Data Structures', 'Economics', 'Statistics', 'Organic Chem'];
  for (let i = 0; i < titles.length; i++) {
    const id = `10000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    bookIds.push(id);
    await db.insert(books).values({
      id,
      regionCode: 'TW',
      isbn13: `97800000000${String(i).padStart(2, '0')}`.slice(0, 13),
      title: titles[i],
      authors: i % 2 ? 'Ann Author' : 'Bob Writer',
      source: 'listed',
      createdAt: ago(8000),
    });
  }
  const hkBook = '10000000-0000-4000-8000-000000000099';
  await db.insert(books).values({ id: hkBook, regionCode: 'HK', title: 'Hong Kong Book', source: 'listed', createdAt: ago(100) });

  const courses = ['Calculus I', 'calculus i ', 'Physics 101', '', 'Intro CS'];
  const profs = ['Dr. Chen', 'dr. chen', 'Prof. Lin', '', 'Dr. Wu'];
  const statuses = ['active', 'active', 'reserved', 'sold', 'removed'] as const;
  const listingIds: string[] = [];
  for (let i = 0; i < 36; i++) {
    const id = `20000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    listingIds.push(id);
    const hours = Math.floor(rnd() * (i < 6 ? 150 : 6500));
    await db.insert(listings).values({
      ...t(id, hours),
      regionCode: 'TW',
      currencyCode: 'TWD',
      bookId: pick(bookIds),
      sellerId: pick(userIds),
      schoolId: pick([1, 3, 4, null]),
      categoryId: pick([11, 12, null]),
      price: 100 + Math.floor(rnd() * 900),
      condition: pick(['new', 'like_new', 'noted', 'damaged'] as const),
      status: pick([...statuses]),
      courseName: pick(courses),
      professorName: pick(profs),
    });
  }
  await db.insert(listings).values({
    ...t('20000000-0000-4000-8000-0000000000ff', 5),
    regionCode: 'HK',
    currencyCode: 'HKD',
    bookId: hkBook,
    sellerId: userIds[0],
    price: 50,
    condition: 'new',
    status: 'active',
  });

  const orderStatuses = ['pending', 'accepted', 'handed_over', 'completed', 'completed', 'completed', 'cancelled'] as const;
  const reasons = ['no_show', 'changed_mind', '', 'sold_elsewhere'];
  const orderIds: string[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < 70; i++) {
    const id = `30000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    orderIds.push(id);
    const hours = Math.floor(rnd() * (i < 12 ? 200 : 6500));
    const status = pick([...orderStatuses]);
    const gone = i % 11 === 0;
    let listingIdx = Math.floor(rnd() * listingIds.length);
    let buyer = pick(userIds);
    // One order per (listing, buyer).
    while (!gone && taken.has(`${listingIdx}|${buyer}`)) {
      listingIdx = Math.floor(rnd() * listingIds.length);
      buyer = pick(userIds);
    }
    taken.add(`${listingIdx}|${buyer}`);
    await db.insert(orders).values({
      id,
      regionCode: 'TW',
      currencyCode: 'TWD',
      listingId: gone ? null : listingIds[listingIdx],
      listingRef: listingIds[listingIdx],
      bookTitle: 'x',
      buyerId: buyer,
      sellerId: pick(userIds.filter((u) => u !== buyer)),
      status,
      cancelReason: status === 'cancelled' ? pick(reasons) : null,
      totalAmount: 100 + Math.floor(rnd() * 900),
      createdAt: ago(hours),
      updatedAt: ago(hours),
      completedAt: status === 'completed' && i % 9 !== 0 ? ago(Math.max(0, hours - 1 - Math.floor(rnd() * 120))) : null,
    });
  }
  await db.insert(orders).values({
    id: '30000000-0000-4000-8000-0000000000ff',
    regionCode: 'HK',
    currencyCode: 'HKD',
    listingId: '20000000-0000-4000-8000-0000000000ff',
    buyerId: userIds[1],
    sellerId: userIds[0],
    status: 'completed',
    totalAmount: 50,
    createdAt: ago(3),
    updatedAt: ago(3),
    completedAt: ago(2),
  });

  for (let i = 0; i < 24; i++) {
    const id = `40000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    const hours = Math.floor(rnd() * 3000);
    const buyer = pick(userIds);
    await db.insert(conversations).values({
      id,
      roomId: id,
      regionCode: 'TW',
      buyerId: buyer,
      sellerId: pick(userIds.filter((u) => u !== buyer)),
      listingId: i % 7 === 0 ? null : pick(listingIds),
      listingRef: pick(listingIds),
      updatedAt: ago(hours),
      createdAt: ago(hours),
    });
  }
  const convs = (await db.select({ id: conversations.id }).from(conversations)).map((c) => c.id);

  for (let i = 0; i < 18; i++) {
    const hours = Math.floor(rnd() * 3000);
    await db
      .insert(subscriptions)
      .values({
        id: `50000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
        regionCode: 'TW',
        userId: userIds[i % userIds.length],
        bookId: bookIds[i % 5 === 4 ? 7 : i % bookIds.length],
        notifiedAt: i % 3 === 0 ? ago(Math.max(0, hours - 5)) : null,
        createdAt: ago(hours),
      })
      .onConflictDoNothing();
  }

  for (let i = 0; i < 8; i++) {
    await db.insert(reports).values({
      id: `60000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
      reporterId: pick(userIds),
      listingId: pick(listingIds),
      regionCode: 'TW',
      reason: pick(['fake', 'scam', 'other'] as const),
      status: pick(['open', 'actioned', 'dismissed'] as const),
      createdAt: ago(Math.floor(rnd() * 2000)),
    });
    await db.insert(chatReports).values({
      id: `70000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
      reporterId: pick(userIds),
      conversationId: pick(convs),
      regionCode: 'TW',
      reportedPartyId: pick(userIds),
      reason: pick(['harassment', 'scam', 'spam', 'other'] as const),
      status: pick(['open', 'actioned', 'dismissed'] as const),
      createdAt: ago(Math.floor(rnd() * 2000)),
    });
  }
  const completedOrders = orderIds.filter((_, i) => i % 2 === 0).slice(0, 20);
  for (const [i, orderId] of completedOrders.entries()) {
    await db.insert(reviews).values({
      orderId,
      reviewerId: userIds[i % 5],
      revieweeId: userIds[(i + 1) % 5],
      rating: i % 6 === 0 ? null : 1 + (i % 5),
      isNoShow: i % 6 === 0 ? 1 : 0,
      createdAt: ago(Math.floor(rnd() * 3000)),
    });
  }
});

afterAll(() => {
  vi.useRealTimers();
});

async function get(path: string) {
  const res = await call(`/api/v1/admin/stats/${path}`, { token: root.token });
  return { status: res.status, body: await res.json() };
}

describe('admin stats answers (characterization)', () => {
  it.each([0, 1, 7, 30, 90, 365])('overview days=%i', async (days) => {
    expect(await get(`overview/?region=TW&days=${days}`)).toMatchSnapshot();
  });

  it.each([1, 7, 30, 365])('timeseries days=%i', async (days) => {
    expect(await get(`timeseries/?region=TW&days=${days}`)).toMatchSnapshot();
  });

  it('book ranking', async () => {
    const qs = [
      '',
      '&days=0',
      '&days=7&sort=gmv',
      '&sort=orders&days=365',
      '&q=calc',
      '&q=chem&days=0',
      '&school=1',
      '&school=none&days=365',
      '&category=11&days=365',
      '&category=none&days=0',
      '&course=calculus i&days=0',
      '&professor=dr. chen&days=365',
      '&school=3&category=12&days=0',
      '&page_size=3&page=2&days=0',
    ];
    for (const q of qs) expect({ q, ...(await get(`books/ranking/?region=TW${q}`)) }).toMatchSnapshot();
  });

  it('book requests', async () => {
    for (const q of ['', '&days=0', '&days=7', '&unlisted=1&days=0', '&q=calc&days=365', '&page_size=2&page=2&days=0']) {
      expect({ q, ...(await get(`books/requests/?region=TW${q}`)) }).toMatchSnapshot();
    }
  });

  it('breakdown', async () => {
    const out: unknown[] = [];
    for (const by of ['school', 'category', 'course', 'professor']) {
      for (const q of [
        '',
        '&days=0',
        '&days=7&sort=gmv',
        '&days=365&sort=new_listings',
        '&sort=active_listings&days=0',
        '&sort=orders&days=90',
      ]) {
        out.push({ by, q, ...(await get(`breakdown/?region=TW&by=${by}${q}`)) });
      }
    }
    out.push(await get('breakdown/?region=TW&by=category&school=3&days=0'));
    out.push(await get('breakdown/?region=TW&by=course&school=1&days=365'));
    out.push(await get('breakdown/?region=TW&by=school&q=ncku&days=0'));
    out.push(await get('breakdown/?region=TW&by=school&page=2&page_size=1&days=0'));
    expect(out).toMatchSnapshot();
  });

  it('one book', async () => {
    const out: unknown[] = [];
    for (const [i, id] of bookIds.entries()) {
      // All-time (a year of daily points) for one book only, to keep the snapshot small.
      for (const days of i < 1 ? [7, 30, 0] : [7, 30]) out.push(await get(`books/${id}/?region=TW&days=${days}`));
    }
    out.push(await get('books/10000000-0000-4000-8000-000000000099/?region=TW'));
    expect(out).toMatchSnapshot();
  });

  it.each([1, 7, 30, 90, 365, 0])('growth days=%i', async (days) => {
    expect(await get(`growth/?region=TW&days=${days}`)).toMatchSnapshot();
  });

  it.each(['all', 'buyer', 'seller'])('retention role=%s', async (role) => {
    expect(await get(`retention/?region=TW&role=${role}`)).toMatchSnapshot();
  });

  it('is never empty', async () => {
    const o = (await get('overview/?region=TW&days=0')).body as { orders: { new: number }; listings: { new: number } };
    expect(o.orders.new).toBeGreaterThan(30);
    expect(o.listings.new).toBeGreaterThan(20);
  });
});
