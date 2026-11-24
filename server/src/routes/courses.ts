/**
 * /api/v1/courses/ — browse by course, and "I am taking this course".
 *
 * A course is whatever sellers typed into a listing's course field; lib/course.ts'
 * key makes two spellings of one course the same course. Everything is scoped
 * to one school: course names mean different things at different schools.
 */
import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { courseWants, createDb, schools } from '../db';
import { apiError, readJson } from '../lib/http';
import { courseKey } from '../lib/course';
import { LIMITS } from '../lib/limits';
import { nowIso } from '../lib/time';
import { UUID_RE } from '../lib/uuid';
import { requireRegion } from '../lib/region';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { checkPlatformRate, checkRate, type PlatformRate } from '../middleware/rateLimit';
import { coverUrlFor } from '../services/catalog/covers';
import { mergeSpellings } from '../services/listings/courses';
import { NO_SCHOOL_ID, schoolFilterId } from '../services/listings/places';
import type { CourseBookDto, CourseDetailDto, CourseDto, CourseWantDto } from '../api-types';

export const courseRoutes = new Hono<AppEnv>();

const COURSE_RATE: PlatformRate = '60/min';
/** Course rows one listing call returns. */
const MAX_COURSES = 200;
/** Courses one account can ask to hear about. */
const MAX_WANTS_PER_USER = 40;

/** The school a ?school= names, or a 404: courses only exist inside a school. */
async function requireSchool(c: Parameters<typeof requireRegion>[0], value: string | undefined) {
  const region = await requireRegion(c);
  const schoolId = await schoolFilterId(c.env, region, value ?? '');
  if (schoolId === null || schoolId === NO_SCHOOL_ID) apiError(404, 'not_found');
  return { region, schoolId };
}

/** Course names typed into listings at a school, with how many listings use each spelling. */
async function listingSpellings(db: D1Database, schoolId: number) {
  const { results } = await db
    .prepare(
      `SELECT course_name AS name,
              count(*) AS total,
              sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              count(DISTINCT book_id) AS books
         FROM listings
        WHERE school_id = ? AND course_name <> ''
        GROUP BY course_name`,
    )
    .bind(schoolId)
    .all<{ name: string; total: number; active: number; books: number }>();
  return results;
}

/** Who wants each course at a school: course key → count. */
async function wantCounts(db: D1Database, schoolId: number) {
  const { results } = await db
    .prepare(`SELECT course_key AS k, count(*) AS n FROM course_wants WHERE school_id = ? GROUP BY course_key`)
    .bind(schoolId)
    .all<{ k: string; n: number }>();
  return new Map(results.map((r) => [r.k, Number(r.n)]));
}

courseRoutes.get('/', optionalAuthMiddleware(), async (c) => {
  await checkPlatformRate(c, 'courses', COURSE_RATE);
  const { schoolId } = await requireSchool(c, c.req.query('school'));
  const q = courseKey((c.req.query('q') ?? '').slice(0, LIMITS.courseName));
  const userId = c.get('userId') ?? null;
  const [spellings, wants, mine] = await Promise.all([
    listingSpellings(c.env.DB, schoolId),
    wantCounts(c.env.DB, schoolId),
    userId
      ? createDb(c.env.DB)
          .select({ k: courseWants.courseKey })
          .from(courseWants)
          .where(and(eq(courseWants.userId, userId), eq(courseWants.schoolId, schoolId)))
      : Promise.resolve([]),
  ]);
  const wanted = new Set(mine.map((r) => r.k));

  // One row per course key, under the spelling most listings use.
  const byKey = new Map<string, CourseDto>();
  for (const m of mergeSpellings(spellings.map((s) => ({ ...s, n: Number(s.total) })))) {
    byKey.set(m.key, {
      key: m.key,
      name: m.name,
      listingCount: m.rows.reduce((sum, r) => sum + Number(r.active), 0),
      // Books are counted per spelling: a book listed under two spellings counts twice. Close enough for a list.
      bookCount: m.rows.reduce((sum, r) => sum + Number(r.books), 0),
      wantCount: wants.get(m.key) ?? 0,
      wanted: wanted.has(m.key),
    });
  }
  // Courses nobody has listed yet but someone is waiting for.
  if (wants.size) {
    const { results } = await c.env.DB.prepare(
      `SELECT course_key AS k, course_name AS name FROM course_wants WHERE school_id = ? GROUP BY course_key`,
    )
      .bind(schoolId)
      .all<{ k: string; name: string }>();
    for (const w of results) {
      if (byKey.has(w.k)) continue;
      byKey.set(w.k, {
        key: w.k,
        name: w.name,
        listingCount: 0,
        bookCount: 0,
        wantCount: wants.get(w.k) ?? 0,
        wanted: wanted.has(w.k),
      });
    }
  }
  const rows = [...byKey.values()]
    .filter((r) => !q || r.key.includes(q))
    .sort((a, b) => b.listingCount - a.listingCount || b.wantCount - a.wantCount || a.name.localeCompare(b.name))
    .slice(0, MAX_COURSES);

  return c.json(rows);
});

courseRoutes.get('/detail', optionalAuthMiddleware(), async (c) => {
  await checkPlatformRate(c, 'courses', COURSE_RATE);
  const { schoolId } = await requireSchool(c, c.req.query('school'));
  const key = courseKey((c.req.query('name') ?? '').slice(0, LIMITS.courseName));
  if (!key) apiError(400, 'common.errValidation');
  const userId = c.get('userId') ?? null;
  const db = createDb(c.env.DB);

  // Every spelling of this course at the school, then the listings under them.
  const merged = mergeSpellings((await listingSpellings(c.env.DB, schoolId)).map((s) => ({ ...s, n: Number(s.total) }))).find(
    (m) => m.key === key,
  );
  const spellings = merged?.rows ?? [];
  const [wants, mine, wantName] = await Promise.all([
    wantCounts(c.env.DB, schoolId),
    userId
      ? db
          .select({ id: courseWants.id })
          .from(courseWants)
          .where(and(eq(courseWants.userId, userId), eq(courseWants.schoolId, schoolId), eq(courseWants.courseKey, key)))
          .limit(1)
      : Promise.resolve([]),
    db
      .select({ name: courseWants.courseName })
      .from(courseWants)
      .where(and(eq(courseWants.schoolId, schoolId), eq(courseWants.courseKey, key)))
      .limit(1),
  ]);
  const name = merged?.name ?? wantName[0]?.name ?? '';
  if (!name) apiError(404, 'not_found');

  let bookRows: Array<{
    id: string;
    title: string;
    authors: string;
    isbn13: string | null;
    cover_url: string;
    cover_r2_key: string | null;
    active: number;
    min_price: number | null;
    last_listed: string;
  }> = [];
  let professors: string[] = [];
  if (spellings.length) {
    const names = JSON.stringify(spellings.map((s) => s.name));
    const [b, p] = await Promise.all([
      c.env.DB.prepare(
        `SELECT b.id, b.title, b.authors, b.isbn13, b.cover_url, b.cover_r2_key,
                sum(CASE WHEN l.status = 'active' THEN 1 ELSE 0 END) AS active,
                min(CASE WHEN l.status = 'active' THEN l.price END) AS min_price,
                max(l.created_at) AS last_listed
           FROM listings l JOIN books b ON b.id = l.book_id
          WHERE l.school_id = ? AND l.course_name IN (SELECT value FROM json_each(?))
          GROUP BY b.id
          ORDER BY active DESC, last_listed DESC
          LIMIT 50`,
      )
        .bind(schoolId, names)
        .all<(typeof bookRows)[number]>(),
      c.env.DB.prepare(
        `SELECT professor_name AS p, count(*) AS n FROM listings
          WHERE school_id = ? AND professor_name <> '' AND course_name IN (SELECT value FROM json_each(?))
          GROUP BY professor_name ORDER BY n DESC LIMIT 10`,
      )
        .bind(schoolId, names)
        .all<{ p: string }>(),
    ]);
    bookRows = b.results;
    professors = p.results.map((r) => r.p);
  }

  const books: CourseBookDto[] = bookRows.map((b) => ({
    id: b.id,
    title: b.title,
    authors: b.authors,
    isbn: b.isbn13 ?? '',
    coverUrl: coverUrlFor(c.env, undefined, { coverUrl: b.cover_url, coverR2Key: b.cover_r2_key }),
    activeCount: Number(b.active),
    minPrice: b.min_price === null ? null : Number(b.min_price),
  }));
  const body: CourseDetailDto = {
    key,
    name,
    wantCount: wants.get(key) ?? 0,
    wanted: mine.length > 0,
    professors,
    books,
  };
  return c.json(body);
});

// ---------------------------------------------------------------------------
// "I am taking this course"
// ---------------------------------------------------------------------------

courseRoutes.use('/wants', authMiddleware());
courseRoutes.use('/wants/*', authMiddleware());

courseRoutes.get('/wants', async (c) => {
  const region = await requireRegion(c);
  const rows = await createDb(c.env.DB)
    .select({
      id: courseWants.id,
      name: courseWants.courseName,
      key: courseWants.courseKey,
      schoolId: courseWants.schoolId,
      schoolCode: schools.code,
      createdAt: courseWants.createdAt,
    })
    .from(courseWants)
    .innerJoin(schools, eq(schools.id, courseWants.schoolId))
    .where(and(eq(courseWants.userId, c.get('userId')!), eq(courseWants.regionCode, region.code)))
    .orderBy(desc(courseWants.createdAt));
  const out: CourseWantDto[] = rows.map((r) => ({ id: r.id, name: r.name, school: r.schoolCode, created_at: r.createdAt }));
  return c.json(out);
});

courseRoutes.post('/wants', async (c) => {
  await checkRate(c, 'course-want', '60/hour');
  const body = await readJson(c.req);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, LIMITS.courseName) : '';
  const key = courseKey(name);
  if (!key) apiError(400, 'common.errValidation');
  const school = typeof body.school === 'string' ? body.school : '';
  const { region, schoolId } = await requireSchool(c, school);
  const userId = c.get('userId')!;
  const db = createDb(c.env.DB);

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(courseWants)
    .where(eq(courseWants.userId, userId));
  if (n >= MAX_WANTS_PER_USER) apiError(400, 'common.errValidation');

  const id = crypto.randomUUID();
  const inserted = await db
    .insert(courseWants)
    .values({ id, regionCode: region.code, userId, schoolId, courseKey: key, courseName: name, notifiedAt: null, createdAt: nowIso() })
    .onConflictDoNothing()
    .returning({ id: courseWants.id });
  const [row] = await db
    .select()
    .from(courseWants)
    .where(and(eq(courseWants.userId, userId), eq(courseWants.schoolId, schoolId), eq(courseWants.courseKey, key)))
    .limit(1);
  const out: CourseWantDto = { id: row.id, name: row.courseName, school, created_at: row.createdAt };
  return c.json(out, inserted.length ? 201 : 200);
});

courseRoutes.delete('/wants/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.body(null, 404);
  const deleted = await createDb(c.env.DB)
    .delete(courseWants)
    .where(and(eq(courseWants.id, id.toLowerCase()), eq(courseWants.userId, c.get('userId')!)))
    .returning({ id: courseWants.id });
  return c.body(null, deleted.length ? 204 : 404);
});
