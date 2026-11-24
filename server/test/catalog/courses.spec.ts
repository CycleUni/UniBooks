import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { createDb, currencies, languages, regions, schools, books, listings, courseWants } from '../../src/db';
import { courseKey } from '../../src/lib/course';
import { runCourseWaitNotify } from '../../src/jobs/index';
import { createUser } from '../accounts/helpers';
import { tokenFor } from '../ads/helpers';
import { mergeSpellings } from '../../src/services/listings/courses';

const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const db = createDb(env.DB);

async function makeUser(name: string) {
  const id = await createUser(`${name}-${crypto.randomUUID().slice(0, 6)}@example.test`, { first: name });
  return { id, token: await tokenFor(id) };
}

function call(path: string, init: RequestInit & { token?: string } = {}, base = '/api/v1/courses') {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  headers.set('X-Region', 'TW');
  if (init.body) headers.set('Content-Type', 'application/json');
  const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
  return worker.fetch(new Request(`http://x${base}${path}`, { ...init, headers }));
}

async function addListing(
  sellerId: string,
  schoolId: number,
  title: string,
  course: string,
  status: 'active' | 'sold' = 'active',
  price = 300,
) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, regionCode: 'TW', isbn13: null, title, source: 'manual', createdAt: now() });
  await db.insert(listings).values({
    id: crypto.randomUUID(),
    regionCode: 'TW',
    currencyCode: 'TWD',
    bookId,
    sellerId,
    schoolId,
    price,
    condition: 'like_new',
    status,
    courseName: course,
    createdAt: now(),
    updatedAt: now(),
  });
  return bookId;
}

describe('courseKey', () => {
  it('treats spelling variants of one course as the same', () => {
    expect(courseKey('微積分 (一)')).toBe(courseKey('微積分（一）'));
    expect(courseKey('Calculus I')).toBe(courseKey('calculus  i'));
    expect(courseKey('微積分')).not.toBe(courseKey('微積分(一)'));
  });
  it('is empty for text that is only punctuation', () => {
    expect(courseKey(' -- ')).toBe('');
  });
});

describe('courses', () => {
  const CHIHLEE = 501;
  const OTHER = 502;
  let seller: { id: string; token: string };

  beforeAll(async () => {
    await db.insert(currencies).values({ code: 'TWD', symbol: 'NT$', decimalPlaces: 0 }).onConflictDoNothing();
    await db.insert(languages).values({ code: 'zh-TW', name: 'Chinese (Taiwan)' }).onConflictDoNothing();
    await db
      .insert(regions)
      .values({
        code: 'TW',
        name: 'Taiwan',
        defaultCurrency: 'TWD',
        defaultLanguage: 'zh-TW',
        timezone: 'Asia/Taipei',
        languages: '["zh-TW"]',
        createdAt: now(),
      })
      .onConflictDoNothing();
    await db
      .insert(schools)
      .values([
        { id: CHIHLEE, regionCode: 'TW', code: 'CHIHLEE', name: 'Chihlee', emailDomain: 'chihlee.test', createdAt: now() },
        { id: OTHER, regionCode: 'TW', code: 'OTHERU', name: 'Other U', emailDomain: 'other.test', createdAt: now() },
      ])
      .onConflictDoNothing();
    seller = await makeUser('seller');
    await addListing(seller.id, CHIHLEE, 'Calculus A', '微積分 (一)');
    await addListing(seller.id, CHIHLEE, 'Calculus B', '微積分（一）', 'sold');
    await addListing(seller.id, OTHER, 'Elsewhere', '微積分 (一)');
  });

  it('merges spellings into one course and keeps schools apart', async () => {
    const res = await call('?school=CHIHLEE');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ key: string; listingCount: number; bookCount: number }>;
    const calc = rows.filter((r) => r.key === courseKey('微積分(一)'));
    expect(calc).toHaveLength(1);
    // One active listing, but both books were listed for the course.
    expect(calc[0].listingCount).toBe(1);
    expect(calc[0].bookCount).toBe(2);
  });

  it('filters the list by a typed name, whatever its punctuation', async () => {
    const rows = (await (await call(`?school=CHIHLEE&q=${encodeURIComponent('微積分 一')}`)).json()) as unknown[];
    expect(rows).toHaveLength(1);
    expect(await (await call(`?school=CHIHLEE&q=${encodeURIComponent('不存在的課')}`)).json()).toEqual([]);
  });

  it('answers 404 for a missing or unknown school', async () => {
    expect((await call('')).status).toBe(404);
    expect((await call('?school=NOPE')).status).toBe(404);
  });

  it("lists a course's books, past ones included, at that school only", async () => {
    const res = await call(`/detail?school=CHIHLEE&name=${encodeURIComponent('微積分(一)')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { books: Array<{ title: string; activeCount: number; minPrice: number | null }> };
    expect(body.books.map((b) => b.title).sort()).toEqual(['Calculus A', 'Calculus B']);
    const a = body.books.find((b) => b.title === 'Calculus A')!;
    const b = body.books.find((b) => b.title === 'Calculus B')!;
    expect(a.activeCount).toBe(1);
    expect(a.minPrice).toBe(300);
    expect(b.activeCount).toBe(0);
    expect(b.minPrice).toBeNull();
    expect((await call(`/detail?school=CHIHLEE&name=${encodeURIComponent('沒有這門課')}`)).status).toBe(404);
  });

  it('records a request once, counts it, and lets the student withdraw it', async () => {
    const student = await makeUser('student');
    const ask = () =>
      call('/wants', { method: 'POST', token: student.token, body: JSON.stringify({ school: 'CHIHLEE', name: '微積分 （一）' }) });
    const first = await ask();
    expect(first.status).toBe(201);
    expect((await ask()).status).toBe(200);
    const want = (await first.json()) as { id: string };

    const detail = (await (
      await call(`/detail?school=CHIHLEE&name=${encodeURIComponent('微積分(一)')}`, { token: student.token })
    ).json()) as {
      wantCount: number;
      wanted: boolean;
    };
    expect(detail.wantCount).toBe(1);
    expect(detail.wanted).toBe(true);
    const mine = (await (await call('/wants', { token: student.token })).json()) as unknown[];
    expect(mine).toHaveLength(1);

    // Somebody else cannot withdraw it.
    const other = await makeUser('other');
    expect((await call(`/wants/${want.id}`, { method: 'DELETE', token: other.token })).status).toBe(404);
    expect((await call(`/wants/${want.id}`, { method: 'DELETE', token: student.token })).status).toBe(204);
  });

  it('needs a signed-in student and a real course name to ask', async () => {
    const body = JSON.stringify({ school: 'CHIHLEE', name: '微積分' });
    expect((await call('/wants', { method: 'POST', body })).status).toBe(401);
    const student = await makeUser('student2');
    const blank = await call('/wants', { method: 'POST', token: student.token, body: JSON.stringify({ school: 'CHIHLEE', name: ' -- ' }) });
    expect(blank.status).toBe(400);
  });

  it('shows a course nobody has listed yet, because somebody is waiting for it', async () => {
    const student = await makeUser('student3');
    await call('/wants', { method: 'POST', token: student.token, body: JSON.stringify({ school: 'CHIHLEE', name: '統計學' }) });
    const rows = (await (await call('?school=CHIHLEE')).json()) as Array<{ name: string; listingCount: number; wantCount: number }>;
    const stats = rows.find((r) => r.name === '統計學');
    expect(stats).toMatchObject({ listingCount: 0, wantCount: 1 });
  });

  describe('notification', () => {
    const run = async () => {
      const sent: Array<Record<string, unknown>> = [];
      const recorder = { send: async (m: Record<string, unknown>) => void sent.push(m) };
      const jobEnv = { ...env, EMAIL_QUEUE: recorder, PUSH_QUEUE: recorder } as unknown as typeof env;
      const result = await runCourseWaitNotify(jobEnv);
      return { sent, result };
    };

    it('tells a student once when a book for their course is listed at their school', async () => {
      const student = await makeUser('waiting');
      const other = await makeUser('elsewhere');
      await db.insert(courseWants).values([
        {
          id: crypto.randomUUID(),
          regionCode: 'TW',
          userId: student.id,
          schoolId: CHIHLEE,
          courseKey: courseKey('會計學'),
          courseName: '會計學',
          createdAt: ago(60_000),
        },
        {
          id: crypto.randomUUID(),
          regionCode: 'TW',
          userId: other.id,
          schoolId: OTHER,
          courseKey: courseKey('會計學'),
          courseName: '會計學',
          createdAt: ago(60_000),
        },
      ]);
      await addListing(seller.id, CHIHLEE, 'Accounting 101', '會計 學');

      const first = await run();
      const mine = first.sent.filter((m) => m.user_id === student.id);
      expect(mine.map((m) => m.type).sort()).toEqual(['waitlist_match', 'waitlist_notification']);
      expect(mine[0].course_name).toBe('會計學');
      // The other school's student hears nothing.
      expect(first.sent.filter((m) => m.user_id === other.id)).toEqual([]);

      const [want] = await db.select().from(courseWants).where(eq(courseWants.userId, student.id));
      expect(want.notifiedAt).toBeTruthy();
      const second = await run();
      expect(second.sent.filter((m) => m.user_id === student.id)).toEqual([]);
    });
  });
});

describe('mergeSpellings', () => {
  it('merges spellings of one course, showing the one most listings use', () => {
    const merged = mergeSpellings([
      { name: '微積分(一)', n: 1 },
      { name: '微積分（一）', n: 3 },
      { name: '統計學', n: 2 },
      { name: ' -- ', n: 9 },
    ]);
    expect(merged.map((m) => [m.name, m.n])).toEqual([
      ['微積分（一）', 4],
      ['統計學', 2],
    ]);
  });

  it('breaks a tie by the shorter spelling, then alphabetically', () => {
    expect(
      mergeSpellings([
        { name: '微積分 (一)', n: 1 },
        { name: '微積分(一)', n: 1 },
      ])[0].name,
    ).toBe('微積分(一)');
  });
});

describe('the search page course filter', () => {
  const SCHOOL = 701;
  const search = (path: string) => call(path, {}, '/api/v1/search');

  beforeAll(async () => {
    await db
      .insert(schools)
      .values({ id: SCHOOL, regionCode: 'TW', code: 'FILTER', name: 'Filter U', emailDomain: 'filter.test', createdAt: now() })
      .onConflictDoNothing();
    const seller = await makeUser('filter-seller');
    await addListing(seller.id, SCHOOL, 'Linear A', '線性代數 (一)');
    await addListing(seller.id, SCHOOL, 'Linear B', '線性代數（一）');
    await addListing(seller.id, SCHOOL, 'Physics', '物理');
  });

  it("lists one facet per course, with the spellings' counts added up", async () => {
    const facets = (await (await search('/courses?school=FILTER')).json()) as Array<{ value: string; count: number }>;
    const linear = facets.filter((f) => courseKey(f.value) === courseKey('線性代數(一)'));
    expect(linear).toHaveLength(1);
    expect(facets.find((f) => f.value === '物理')).toMatchObject({ count: 1 });
  });

  it('finds the books of every spelling when filtering on one', async () => {
    const res = await search(`/books?school=FILTER&course=${encodeURIComponent('線性代數 (一)')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ title: string }> };
    expect(body.results.map((r) => r.title).sort()).toEqual(['Linear A', 'Linear B']);
  });

  it('still finds nothing for a course nobody lists', async () => {
    const body = (await (await search(`/books?school=FILTER&course=${encodeURIComponent('不存在的課')}`)).json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });
});
