import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { books, courseWants, createDb, listings, schools } from '../../src/db';
import { courseKey } from '../../src/lib/course';
import { createUser } from '../accounts/helpers';
import { call, seedReference, staff } from '../ads/helpers';

const db = createDb(env.DB);
const now = () => new Date().toISOString();

const student = (name: string) => createUser(`${name}-${crypto.randomUUID().slice(0, 6)}@example.test`, { first: name });

describe('admin course demand', () => {
  let root: { id: string; token: string };

  beforeAll(async () => {
    await seedReference();
    root = await staff('demand-root@example.com', { admin: true });
    await db
      .insert(schools)
      .values({ id: 601, regionCode: 'TW', code: 'DEMAND', name: 'Demand U', emailDomain: 'demand.test', createdAt: now() });
    const seller = await student('seller');
    const [a, b, c] = [await student('a'), await student('b'), await student('c')];
    const want = (userId: string, name: string) =>
      db.insert(courseWants).values({
        id: crypto.randomUUID(),
        regionCode: 'TW',
        userId,
        schoolId: 601,
        courseKey: courseKey(name),
        courseName: name,
        createdAt: now(),
      });
    await want(a, '經濟學');
    await want(b, '經濟學 ');
    await want(c, '統計學');
    // One book for sale under a variant spelling of 經濟學; none for 統計學.
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, regionCode: 'TW', title: 'Economics', source: 'manual', createdAt: now() });
    await db.insert(listings).values({
      id: crypto.randomUUID(),
      regionCode: 'TW',
      currencyCode: 'TWD',
      bookId,
      sellerId: seller,
      schoolId: 601,
      price: 100,
      condition: 'new',
      courseName: '經 濟 學',
      createdAt: now(),
      updatedAt: now(),
    });
  });

  it('ranks courses by requests against what is for sale, and counts the supply gap', async () => {
    const res = await call('/api/v1/admin/stats/courses/demand?region=TW', { token: root.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ course: string; request_count: number; active_listings: number }>;
      summary: { requests: number; students: number; courses: number; unmet_courses: number };
    };
    expect(body.results[0]).toMatchObject({ course: '經濟學', request_count: 2, active_listings: 1 });
    expect(body.results[1]).toMatchObject({ course: '統計學', request_count: 1, active_listings: 0 });
    expect(body.summary).toEqual({ requests: 3, students: 3, courses: 2, unmet_courses: 1 });
  });

  it('is for staff only and needs a region', async () => {
    expect((await call('/api/v1/admin/stats/courses/demand?region=TW')).status).toBe(401);
    expect((await call('/api/v1/admin/stats/courses/demand', { token: root.token })).status).toBe(400);
  });
});
