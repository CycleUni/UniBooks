/**
 * /api/v1/search/
 */
import { Hono } from 'hono';
import { cached, versionedEdgeCache } from '../lib/cache';
import { validateBookIsbn } from '../services/catalog/isbn';
import type { AppEnv, Env } from '../env';
import { requireRegion, setSharedCache } from '../lib/region';
import { optionalAuthMiddleware } from '../middleware/auth';
import { checkRate } from '../middleware/rateLimit';
import { cleanPublisher, describeSource, type Engine } from '../services/catalog/common';
import {
  ISBN_FALLBACK_ORDER,
  ISBN_LOOKUPS,
  KEYWORD_FALLBACK_ORDER,
  KEYWORD_LOOKUPS,
  SOURCE_BY_ENGINE,
  engineOrder,
  lookupInOrder,
  regionSearchEngines,
  type Attempt,
  type BookRecord,
} from '../services/catalog/lookups';
import { categoryIdsMatchingText, regionCategories, schoolFilterId, schoolFilterScope } from '../services/listings/places';
import { CONDITIONS } from '../services/listings/validate';
import { pagination } from '../lib/http';

export const searchRoutes = new Hono<AppEnv>();

const SEARCH_RATE = '60/min';
/** Browsing by category/course reads at most this many books (results_truncated says when it bit). */
export const LOCAL_BROWSE_LIMIT = 200;

/** A SQL fragment and its bind values, in order. */
interface Frag {
  sql: string;
  args: unknown[];
}
const frag = (sql: string, ...args: unknown[]): Frag => ({ sql, args });
const EMPTY: Frag = frag('');
function join(parts: Frag[], sep = ' AND '): Frag {
  const live = parts.filter((p) => p.sql);
  return { sql: live.map((p) => p.sql).join(sep), args: live.flatMap((p) => p.args) };
}
/** " AND <a> AND <b>" for appending to an existing WHERE. */
function andAll(parts: Frag[]): Frag {
  const j = join(parts);
  return j.sql ? { sql: ` AND ${j.sql}`, args: j.args } : EMPTY;
}
const contains = (col: string, q: string) => frag(`instr(upper(${col}), upper(?)) > 0`, q);
const jsonList = (values: unknown[]) => JSON.stringify(values);

interface LocalBook {
  id: string;
  isbn13: string | null;
  title: string;
  authors: string;
  publisher: string;
  published_date: string;
  cover_url: string;
  source: string;
}

interface Item {
  id?: string;
  isbn: string | null;
  title: string;
  authors: string;
  publisher: string;
  published_date: string;
  cover_url: string;
  source: string;
  debug_source?: string | null;
}

const BOOK_COLS = 'b.id, b.isbn13, b.title, b.authors, b.publisher, b.published_date, b.cover_url, b.source';
const toItem = (b: LocalBook): Item => ({
  id: String(b.id),
  isbn: b.isbn13,
  title: b.title,
  authors: b.authors,
  publisher: b.publisher,
  published_date: b.published_date,
  cover_url: b.cover_url,
  source: b.source,
});

async function all<T>(env: Env, f: Frag): Promise<T[]> {
  return (
    await env.DB.prepare(f.sql)
      .bind(...f.args)
      .all<T>()
  ).results;
}

/** The ISBN registry cannot run a keyword search; Google stands in for it. */
const keywordEngine = (engine: string | null) => (engine === 'isbnnet' ? 'googlebooks' : engine);

/** Category id(s) behind a slug in the region; [-1] (matches nothing) when unknown. */
async function categoryIdsForSlug(env: Env, regionCode: string, slug: string): Promise<number[]> {
  const ids = (await regionCategories(env, regionCode)).filter((c) => c.slug === slug).map((c) => c.id);
  return ids.length ? ids : [-1];
}

searchRoutes.get('/books', optionalAuthMiddleware(), async (c) => {
  await checkRate(c, 'search', SEARCH_RATE);
  const env = c.env;
  // Bounded: every distinct query is a DB scan plus an external lookup.
  const query = (c.req.query('q') ?? '').slice(0, 100);
  const category = c.req.query('category') ?? '';
  const course = c.req.query('course') ?? '';
  const region = await requireRegion(c);
  const { schoolId, city } = await schoolFilterScope(env, region, c.req.query('school') ?? '');
  let scope: 'all' | 'school' | 'city' = schoolId === null ? 'all' : 'school';

  const conditionParam = c.req.query('condition');
  const allowedConditions: string[] | null = conditionParam === 'none' ? [] : conditionParam ? conditionParam.split(',') : null;
  const digits = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
  const pMin = digits(c.req.query('price_min'));
  const pMax = digits(c.req.query('price_max'));
  const filterPrice = pMin !== null || pMax !== null;
  const inStockRequired = c.req.query('in_stock') === '1';

  const allowed = regionSearchEngines(region);
  const requested = c.req.query('engine') ?? null;
  const engine = requested && (allowed as string[]).includes(requested) ? requested : null;

  const listingFiltered = allowedConditions !== null || filterPrice || inStockRequired;
  if (!query && !category && !course && !listingFiltered) return c.json([]);

  const categoryIds = category ? await categoryIdsForSlug(env, region.code, category) : null;
  const catFrag = (alias = 'l') =>
    categoryIds ? frag(`${alias}.category_id IN (SELECT value FROM json_each(?))`, jsonList(categoryIds)) : EMPTY;
  const courseFrag = (alias = 'l') => (course ? frag(`${alias}.course_name = ?`, course) : EMPTY);
  const condFrag = (alias = 'l') =>
    allowedConditions !== null ? frag(`${alias}.condition IN (SELECT value FROM json_each(?))`, jsonList(allowedConditions)) : EMPTY;
  const schoolFrag = (alias = 'l') => (schoolId !== null ? frag(`${alias}.school_id = ?`, schoolId) : EMPTY);
  const cityFrag = (cityId: number, alias = 'l') => frag(`${alias}.school_id IN (SELECT id FROM schools WHERE city_id = ?)`, cityId);

  let googleUnavailable = false;
  let resultsTruncated = false;
  let results: Item[] = [];
  const browseBranch = !!category || (!query && (!!course || listingFiltered));
  const queryStripped = query.trim();
  // A real ISBN (check digit and, for 13 digits, the Bookland prefix): a
  // random 10/13-digit number is searched as text, not run through every
  // ISBN source.
  const isIsbn = /^\d+$/.test(queryStripped) && validateBookIsbn(queryStripped) !== null;

  if (browseBranch) {
    const browse = async (place: Frag) => {
      const exists = andAll([catFrag(), courseFrag(), place, condFrag()]);
      const price: Frag[] = [];
      const minSql = `(SELECT MIN(lp.price) FROM listings lp WHERE lp.book_id = b.id AND lp.status = 'active')`;
      if (pMin !== null) price.push(frag(`${minSql} >= ?`, pMin));
      if (pMax !== null) price.push(frag(`${minSql} <= ?`, pMax));
      const f = join([
        frag(`SELECT ${BOOK_COLS} FROM books b WHERE b.region_code = ?`, region.code),
        frag(`EXISTS (SELECT 1 FROM listings l WHERE l.book_id = b.id AND l.status = 'active'${exists.sql})`, ...exists.args),
        ...price,
      ]);
      return all<LocalBook>(env, frag(`${f.sql} ORDER BY b.created_at DESC LIMIT ${LOCAL_BROWSE_LIMIT}`, ...f.args));
    };
    let rows = await browse(schoolFrag());
    // Nothing at the chosen school: the same browse over its city.
    if (!rows.length && city) {
      const cityRows = await browse(cityFrag(city.id));
      if (cityRows.length) {
        rows = cityRows;
        scope = 'city';
      }
    }
    resultsTruncated = rows.length === LOCAL_BROWSE_LIMIT;
    results = rows.map(toItem);
  } else {
    const attempts: Attempt[] = [];
    let external: Item[] = [];
    let localRows: LocalBook[];

    if (isIsbn) {
      const found = await lookupInOrder(env, queryStripped, engineOrder(engine, allowed, ISBN_FALLBACK_ORDER), ISBN_LOOKUPS, allowed);
      googleUnavailable ||= found.googleUnavailable;
      attempts.push(...found.meta.attempts);
      if (found.result && found.engine) {
        external = [
          {
            ...(found.result as BookRecord),
            source: SOURCE_BY_ENGINE[found.engine],
            debug_source: describeSource(found.engine, found.meta.cache_hit ?? false),
          },
        ];
      }
      localRows = await all<LocalBook>(
        env,
        frag(`SELECT ${BOOK_COLS} FROM books b WHERE b.isbn13 = ? AND b.region_code = ?`, queryStripped, region.code),
      );
      // The strict lookup sometimes misses a book the catalogue's keyword
      // search has under this exact ISBN; keep only exact-ISBN matches.
      if (!external.length && !localRows.length) {
        const fb = await lookupInOrder(
          env,
          queryStripped,
          engineOrder(keywordEngine(engine), allowed, KEYWORD_FALLBACK_ORDER),
          KEYWORD_LOOKUPS,
          allowed,
        );
        googleUnavailable ||= fb.googleUnavailable;
        attempts.push(...fb.meta.attempts);
        external = (fb.result ?? [])
          .filter((item) => item.isbn === queryStripped)
          .map((item) => ({ ...item, source: SOURCE_BY_ENGINE[fb.engine as Engine] }));
      }
    } else {
      const found = await lookupInOrder(
        env,
        query,
        engineOrder(keywordEngine(engine), allowed, KEYWORD_FALLBACK_ORDER),
        KEYWORD_LOOKUPS,
        allowed,
      );
      googleUnavailable ||= found.googleUnavailable;
      attempts.push(...found.meta.attempts);
      if (found.engine) {
        const debugSource = describeSource(found.engine, found.meta.cache_hit ?? false);
        external = (found.result ?? []).map((item) => ({ ...item, source: SOURCE_BY_ENGINE[found.engine!], debug_source: debugSource }));
      }

      // Course, professor and category name are the listing's: only an
      // active listing makes them a match.
      const catMatch = await categoryIdsMatchingText(env, region.code, query);
      const ownText = join(
        [
          contains('l.course_name', query),
          contains('l.professor_name', query),
          frag('l.category_id IN (SELECT value FROM json_each(?))', jsonList(catMatch)),
        ],
        ' OR ',
      );
      const listingMatch = andAll([frag(`(${ownText.sql})`, ...ownText.args), schoolFrag()]);
      const bookText = join([contains('b.title', query), contains('b.authors', query), contains("coalesce(b.isbn13, '')", query)], ' OR ');
      const parts: Frag[] = [
        frag(`SELECT ${BOOK_COLS} FROM books b WHERE b.region_code = ?`, region.code),
        frag(
          `(${bookText.sql} OR EXISTS (SELECT 1 FROM listings l WHERE l.book_id = b.id AND l.status = 'active'${listingMatch.sql}))`,
          ...bookText.args,
          ...listingMatch.args,
        ),
      ];
      if (course) {
        const cf = andAll([courseFrag(), schoolFrag()]);
        parts.push(frag(`EXISTS (SELECT 1 FROM listings l WHERE l.book_id = b.id AND l.status = 'active'${cf.sql})`, ...cf.args));
      }
      const f = join(parts);
      // Capped so the merge with the catalogue results stays bounded.
      localRows = await all<LocalBook>(env, frag(`${f.sql} ORDER BY b.created_at DESC LIMIT 100`, ...f.args));
    }

    // Every external catalogue timed out or failed and nothing is local: the
    // book might exist, we just could not ask anyone.
    if (!external.length && !localRows.length && attempts.length) {
      if (attempts.every((a) => a.status === 'timeout' || a.status === 'error' || a.status === 'rate_limited')) {
        return c.json({ error: { code: 'sell.upstreamTimeout' }, attempts, results: [] }, 504);
      }
    }

    const seen = new Set<string>();
    for (const item of [...localRows.map(toItem), ...external]) {
      if (item.isbn && !seen.has(item.isbn)) {
        seen.add(item.isbn);
        results.push(item);
      } else if (!item.isbn && item.id) {
        results.push(item);
      }
    }
  }

  // "Local" from here on: the chosen school, or its city once the browse fell back to it.
  const localPlace = (alias = 'l'): Frag =>
    scope === 'city' && city ? cityFrag(city.id, alias) : schoolId !== null ? frag(`${alias}.school_id = ?`, schoolId) : EMPTY;

  const isbns = results.map((r) => r.isbn).filter((x): x is string => !!x);
  const ids = results.map((r) => r.id).filter((x): x is string => !!x);
  interface Annotated {
    id: string;
    isbn13: string | null;
    g: number;
    lc: number;
    cc: number;
    mp: number | null;
    w: number;
  }
  const byIsbn = new Map<string, Annotated>();
  const byId = new Map<string, Annotated>();
  if (isbns.length || ids.length) {
    const lp = andAll([localPlace()]);
    const cc = city
      ? frag(`(SELECT count(*) FROM listings l WHERE l.book_id = b.id AND l.status = 'active' AND ${cityFrag(city.id).sql})`, city.id)
      : frag('0');
    const rows = await all<Annotated>(
      env,
      frag(
        `SELECT b.id, b.isbn13,
           (SELECT count(*) FROM listings l WHERE l.book_id = b.id AND l.status = 'active') AS g,
           (SELECT count(*) FROM listings l WHERE l.book_id = b.id AND l.status = 'active'${lp.sql}) AS lc,
           ${cc.sql} AS cc,
           (SELECT MIN(l.price) FROM listings l WHERE l.book_id = b.id AND l.status = 'active') AS mp,
           (SELECT count(*) FROM subscriptions s WHERE s.book_id = b.id) AS w
         FROM books b
        WHERE b.region_code = ?
          AND (b.isbn13 IN (SELECT value FROM json_each(?)) OR b.id IN (SELECT value FROM json_each(?)))`,
        ...lp.args,
        ...cc.args,
        region.code,
        jsonList(isbns),
        jsonList(ids),
      ),
    );
    for (const r of rows) {
      if (r.isbn13) byIsbn.set(r.isbn13, r);
      byId.set(String(r.id), r);
    }
  }

  const conditionsByBook = new Map<string, string[]>();
  if (byId.size) {
    const lp = andAll([localPlace()]);
    const rows = await all<{ book_id: string; condition: string }>(
      env,
      frag(
        `SELECT DISTINCT l.book_id, l.condition FROM listings l
          WHERE l.book_id IN (SELECT value FROM json_each(?)) AND l.status = 'active'${lp.sql}`,
        jsonList([...byId.keys()]),
        ...lp.args,
      ),
    );
    for (const r of rows) {
      const list = conditionsByBook.get(r.book_id) ?? [];
      list.push(r.condition);
      conditionsByBook.set(r.book_id, list);
    }
  }

  const subscriptionByBook = new Map<string, string>();
  const userId = c.get('userId');
  if (userId && byIsbn.size) {
    const rows = await all<{ id: string; book_id: string }>(
      env,
      frag(
        `SELECT id, book_id FROM subscriptions
          WHERE region_code = ? AND user_id = ? AND book_id IN (SELECT value FROM json_each(?))`,
        region.code,
        userId,
        jsonList([...byIsbn.values()].map((b) => b.id)),
      ),
    );
    for (const r of rows) subscriptionByBook.set(r.book_id, r.id);
  }

  const enhanced = results.map((item) => {
    const book = (item.id ? byId.get(item.id) : undefined) ?? (item.isbn ? byIsbn.get(item.isbn) : undefined);
    const subscriptionId = book ? (subscriptionByBook.get(book.id) ?? null) : null;
    return {
      id: book ? String(book.id) : '',
      title: item.title ?? '',
      author: item.authors ?? '',
      isbn: item.isbn || '',
      coverUrl: item.cover_url ?? '',
      publisher: cleanPublisher(item.publisher ?? ''),
      published_date: item.published_date ?? '',
      source: item.source ?? 'manual',
      debug_source: item.debug_source ?? null,
      activeListings: book ? Number(book.g) : 0,
      localActiveListings: book ? Number(book.lc) : 0,
      cityActiveListings: book ? Number(book.cc) : 0,
      minPrice: book ? Number(book.mp ?? 0) : 0,
      waitlistCount: book ? Number(book.w) : 0,
      conditions: book ? (conditionsByBook.get(book.id) ?? []) : [],
      is_subscribed: subscriptionId !== null,
      subscription_id: subscriptionId,
    };
  });

  const filtered = enhanced.filter((item) => {
    const inStock = item.activeListings > 0;
    if (inStockRequired && !inStock) return false;
    if (filterPrice) {
      if (!inStock) return false;
      if (pMin !== null && item.minPrice < pMin) return false;
      if (pMax !== null && item.minPrice > pMax) return false;
    }
    if (allowedConditions !== null && !item.conditions.some((x) => allowedConditions.includes(x))) return false;
    return true;
  });

  // ---- facets: each facet ignores its own filter ----
  let textFrag: Frag = EMPTY;
  if (!browseBranch && queryStripped) {
    if (isIsbn) textFrag = frag('b.isbn13 = ?', queryStripped);
    else {
      const catMatch = await categoryIdsMatchingText(env, region.code, queryStripped);
      const t = join(
        [
          contains('b.title', queryStripped),
          contains('b.authors', queryStripped),
          contains("coalesce(b.isbn13, '')", queryStripped),
          contains('l.course_name', queryStripped),
          contains('l.professor_name', queryStripped),
          frag('l.category_id IN (SELECT value FROM json_each(?))', jsonList(catMatch)),
        ],
        ' OR ',
      );
      textFrag = frag(`(${t.sql})`, ...t.args);
    }
  }
  const facetBase = (...extra: Frag[]) =>
    andAll([frag("l.status = 'active'"), frag('b.region_code = ?', region.code), localPlace(), textFrag, ...extra]);

  const catWhere = facetBase(courseFrag());
  const catRows = await all<{ slug: string; n: number }>(
    env,
    frag(
      `SELECT c.slug AS slug, count(DISTINCT l.book_id) AS n
         FROM listings l JOIN books b ON b.id = l.book_id JOIN categories c ON c.id = l.category_id
        WHERE 1 = 1${catWhere.sql} GROUP BY c.slug`,
      ...catWhere.args,
    ),
  );
  const catCounts = new Map(catRows.map((r) => [r.slug, Number(r.n)]));
  const categoryFacets = (await regionCategories(env, region.code)).map((cat) => ({
    value: cat.slug,
    count: catCounts.get(cat.slug) ?? 0,
  }));

  const courseWhere = facetBase(catFrag());
  const courseRows = await all<{ course_name: string; n: number }>(
    env,
    frag(
      `SELECT l.course_name, count(DISTINCT l.book_id) AS n
         FROM listings l JOIN books b ON b.id = l.book_id
        WHERE l.course_name <> ''${courseWhere.sql} GROUP BY l.course_name`,
      ...courseWhere.args,
    ),
  );
  const courseCounts = new Map(courseRows.map((r) => [r.course_name, Number(r.n)]));
  const topWhere = andAll([frag("l.status = 'active'"), frag('b.region_code = ?', region.code), localPlace(), catFrag()]);
  const topCourses = await all<{ course_name: string }>(
    env,
    frag(
      `SELECT l.course_name, count(l.id) AS n
         FROM listings l JOIN books b ON b.id = l.book_id
        WHERE l.course_name <> ''${topWhere.sql}
        GROUP BY l.course_name ORDER BY n DESC, l.course_name LIMIT 20`,
      ...topWhere.args,
    ),
  );
  const courseFacets = topCourses.map((r) => ({ value: r.course_name, count: courseCounts.get(r.course_name) ?? 0 }));

  const condWhere = facetBase(catFrag(), courseFrag());
  const condRows = await all<{ condition: string; n: number }>(
    env,
    frag(
      `SELECT l.condition, count(DISTINCT l.book_id) AS n
         FROM listings l JOIN books b ON b.id = l.book_id
        WHERE 1 = 1${condWhere.sql} GROUP BY l.condition`,
      ...condWhere.args,
    ),
  );
  const condCounts = new Map(condRows.map((r) => [r.condition, Number(r.n)]));
  const conditionFacets = CONDITIONS.map((value) => ({ value, count: condCounts.get(value) ?? 0 }));

  const facets = { condition: conditionFacets, category: categoryFacets, course: courseFacets };
  const localCount = filtered.filter((i) => i.localActiveListings > 0).length;
  const cityCount = filtered.filter((i) => i.cityActiveListings > 0).length;

  const p = pagination(c.req.url);
  const page = p.wrap(filtered.slice(p.offset, p.offset + p.limit), filtered.length);
  return c.json({
    ...page,
    google_unavailable: googleUnavailable,
    results_truncated: resultsTruncated,
    facets,
    local_count: localCount,
    scope,
    city: city?.code ?? null,
    city_count: cityCount,
  });
});

searchRoutes.get('/courses', (c) =>
  versionedEdgeCache(c, 'search', async () => {
    await checkRate(c, 'search', SEARCH_RATE);
    const region = await requireRegion(c);
    const category = (c.req.query('category') ?? '').slice(0, 64);
    const schoolId = await schoolFilterId(c.env, region, c.req.query('school') ?? '');
    // Resolve the slug first: an unknown category is an empty answer, never a cache entry.
    const categoryIds = category ? await categoryIdsForSlug(c.env, region.code, category) : null;
    if (categoryIds && !categoryIds.length) return c.json([]);
    // Viewer-independent aggregate over every active listing: cache briefly.
    const body = await cached(
      c.env,
      'search',
      `courses:${region.code}:${schoolId ?? ''}:${categoryIds?.join('.') ?? ''}`,
      300,
      async () => {
        const parts: Frag[] = [frag("l.region_code = ? AND l.status = 'active' AND l.course_name <> ''", region.code)];
        if (schoolId !== null) parts.push(frag('l.school_id = ?', schoolId));
        if (category) {
          parts.push(frag('l.category_id IN (SELECT value FROM json_each(?))', jsonList(categoryIds ?? [])));
        }
        const w = join(parts);
        const rows = await all<{ course_name: string; n: number }>(
          c.env,
          frag(
            `SELECT l.course_name, count(l.id) AS n FROM listings l WHERE ${w.sql}
        GROUP BY l.course_name ORDER BY n DESC, l.course_name LIMIT 20`,
            ...w.args,
          ),
        );
        return rows.map((r) => ({ value: r.course_name, count: Number(r.n) }));
      },
    );
    await setSharedCache(c, { maxAge: 300 });
    return c.json(body);
  }),
);
