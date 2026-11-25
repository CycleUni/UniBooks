import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { createDb, currencies, languages, regions, schools, books, listings, courseWants, subscriptions } from '../../src/db';
import { courseKey } from '../../src/lib/course';
import { runCourseWaitNotify, runWaitlistNotify, purgeExpiredRequests } from '../../src/jobs/index';
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

    it('still tells the newest request when hundreds of older ones sit before it, whether or not they were told', async () => {
      const crowd = await makeUser('crowd');
      // 510 requests from long ago, none of them matching anything listed.
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 510)
         INSERT INTO course_wants (id, region_code, user_id, school_id, course_key, course_name, created_at)
         SELECT 'crowd-' || i, 'TW', ?, ?, 'crowd' || i, 'Crowd ' || i, ? FROM n`,
      )
        .bind(crowd.id, CHIHLEE, ago(3_600_000))
        .run();
      const newest = await makeUser('newest');
      await db.insert(courseWants).values({
        id: crypto.randomUUID(),
        regionCode: 'TW',
        userId: newest.id,
        schoolId: CHIHLEE,
        courseKey: courseKey('作業研究'),
        courseName: '作業研究',
        createdAt: ago(60_000),
      });
      await addListing(seller.id, CHIHLEE, 'Operations Research', '作業研究');

      const { sent } = await run();
      expect(
        sent
          .filter((m) => m.user_id === newest.id)
          .map((m) => m.type)
          .sort(),
      ).toEqual(['waitlist_match', 'waitlist_notification']);
      // And the crowd, which has nothing new, hears nothing.
      expect(sent.filter((m) => m.user_id === crowd.id)).toEqual([]);
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

describe('request expiry (book and course requests)', () => {
  const SCHOOL = 501;
  const MONTH = 30 * 24 * 3_600_000;
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
      .values({ id: SCHOOL, regionCode: 'TW', code: 'CHIHLEE', name: 'Chihlee', emailDomain: 'chihlee.test', createdAt: now() })
      .onConflictDoNothing();
    seller = await makeUser('expiry-seller');
  });

  const postCourse = (token: string, name: string, duration?: string) =>
    call('/wants', { method: 'POST', token, body: JSON.stringify({ school: 'CHIHLEE', name, ...(duration ? { duration } : {}) }) });

  it('a course request lasts half a year unless the student chooses no end', async () => {
    const student = await makeUser('student-expiry');
    const half = (await (await postCourse(student.token, '統計學')).json()) as { expires_at: string | null };
    const months = (new Date(half.expires_at!).getTime() - Date.now()) / MONTH;
    expect(months).toBeGreaterThan(5.8);
    expect(months).toBeLessThan(6.3);
    const open = (await (await postCourse(student.token, '會計學', 'unlimited')).json()) as { expires_at: string | null };
    expect(open.expires_at).toBeNull();
  });

  it('changing the duration restarts the half year, or removes the end', async () => {
    const student = await makeUser('student-patch');
    const want = (await (await postCourse(student.token, '經濟學', 'unlimited')).json()) as { id: string };
    const back = await call(`/wants/${want.id}`, {
      method: 'PATCH',
      token: student.token,
      body: JSON.stringify({ duration: 'half_year' }),
    });
    expect(back.status).toBe(200);
    expect(((await back.json()) as { expires_at: string | null }).expires_at).toBeTruthy();
    const open = await call(`/wants/${want.id}`, {
      method: 'PATCH',
      token: student.token,
      body: JSON.stringify({ duration: 'unlimited' }),
    });
    expect(((await open.json()) as { expires_at: string | null }).expires_at).toBeNull();
    // Someone else's request is not theirs to change.
    const other = await makeUser('student-other');
    expect(
      (await call(`/wants/${want.id}`, { method: 'PATCH', token: other.token, body: JSON.stringify({ duration: 'half_year' }) })).status,
    ).toBe(404);
  });

  it('an expired course request is gone from the lists and counts, and asking again starts over', async () => {
    const student = await makeUser('student-lapsed');
    const first = (await (await postCourse(student.token, '作業系統')).json()) as { id: string };
    await db
      .update(courseWants)
      .set({ expiresAt: ago(1000) })
      .where(eq(courseWants.id, first.id));

    expect(await (await call('/wants', { token: student.token })).json()).toEqual([]);
    const detail = await call(`/detail?school=CHIHLEE&name=${encodeURIComponent('作業系統')}`);
    expect(detail.status).toBe(404); // nobody waits and nothing is listed

    const again = await postCourse(student.token, '作業系統');
    expect(again.status).toBe(201);
    const [row] = await db
      .select()
      .from(courseWants)
      .where(eq(courseWants.userId, (await db.select().from(courseWants).where(eq(courseWants.id, first.id)))[0].userId));
    expect(new Date(row.expiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(((await (await call('/wants', { token: student.token })).json()) as unknown[]).length).toBe(1);
  });

  it('the notifier does not tell a student whose course request lapsed', async () => {
    const student = await makeUser('student-silent');
    await db.insert(courseWants).values({
      id: crypto.randomUUID(),
      regionCode: 'TW',
      userId: student.id,
      schoolId: SCHOOL,
      courseKey: courseKey('資料庫'),
      courseName: '資料庫',
      createdAt: ago(7 * MONTH),
      expiresAt: ago(MONTH),
    });
    await addListing(seller.id, SCHOOL, 'Databases', '資料庫');
    const result = await runCourseWaitNotify(env);
    expect(result.notified_users).toBe(0);
  });

  it('the nightly cleanup deletes lapsed requests of both kinds and keeps the rest', async () => {
    const student = await makeUser('student-clean');
    const keep = crypto.randomUUID();
    await db.insert(courseWants).values([
      {
        id: crypto.randomUUID(),
        regionCode: 'TW',
        userId: student.id,
        schoolId: SCHOOL,
        courseKey: 'old',
        courseName: 'Old',
        createdAt: ago(7 * MONTH),
        expiresAt: ago(MONTH),
      },
      {
        id: keep,
        regionCode: 'TW',
        userId: student.id,
        schoolId: SCHOOL,
        courseKey: 'forever',
        courseName: 'Forever',
        createdAt: ago(7 * MONTH),
        expiresAt: null,
      },
    ]);
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, regionCode: 'TW', isbn13: null, title: 'Wanted once', source: 'manual', createdAt: now() });
    await db
      .insert(subscriptions)
      .values({ id: crypto.randomUUID(), regionCode: 'TW', userId: student.id, bookId, createdAt: ago(7 * MONTH), expiresAt: ago(MONTH) });

    expect(await purgeExpiredRequests(env)).toBeGreaterThanOrEqual(2);
    const left = await db.select().from(courseWants).where(eq(courseWants.userId, student.id));
    expect(left.map((w) => w.id)).toEqual([keep]);
    expect(await db.select().from(subscriptions).where(eq(subscriptions.userId, student.id))).toEqual([]);
  });

  describe('book requests', () => {
    const subscribe = (token: string, bookId: string, duration?: string) =>
      call(
        '',
        { method: 'POST', token, body: JSON.stringify({ book_id: bookId, ...(duration ? { duration } : {}) }) },
        '/api/v1/subscriptions',
      );

    it('lasts half a year by default, can be made endless, and lapses out of the list', async () => {
      const student = await makeUser('book-student');
      const bookId = await addListing(seller.id, SCHOOL, 'Some book', 'X', 'sold');
      const made = (await (await subscribe(student.token, bookId)).json()) as { id: string; expires_at: string | null };
      expect(made.expires_at).toBeTruthy();

      const patched = await call(
        `/${made.id}`,
        { method: 'PATCH', token: student.token, body: JSON.stringify({ duration: 'unlimited' }) },
        '/api/v1/subscriptions',
      );
      expect(((await patched.json()) as { expires_at: string | null }).expires_at).toBeNull();

      await db
        .update(subscriptions)
        .set({ expiresAt: ago(1000) })
        .where(eq(subscriptions.id, made.id));
      expect(await (await call('', { token: student.token }, '/api/v1/subscriptions')).json()).toEqual([]);
      // Asking again after it lapsed is a fresh request, not a no-op on the dead row.
      expect((await subscribe(student.token, bookId)).status).toBe(201);
      expect(((await (await call('', { token: student.token }, '/api/v1/subscriptions')).json()) as unknown[]).length).toBe(1);
    });

    it('the notifier skips a lapsed request', async () => {
      const student = await makeUser('book-silent');
      const bookId = await addListing(seller.id, SCHOOL, 'Fresh listing', 'Y');
      await db.insert(subscriptions).values({
        id: crypto.randomUUID(),
        regionCode: 'TW',
        userId: student.id,
        bookId,
        createdAt: ago(7 * MONTH),
        expiresAt: ago(MONTH),
      });
      const result = await runWaitlistNotify(env);
      expect(result.notified_subscriptions).toBe(0);
    });
  });
});
