import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { books, createDb, listings, orders, schools, users, type Database } from '../../db';
import { apiError, pagination, readJson } from '../../lib/http';
import { getRegion } from '../../lib/region';
import { auditInsert, writeAudit } from '../../services/admin/audit';
import { localized, resolveLanguage } from '../../services/admin/i18n';
import { adminSchoolFilterId } from '../../services/admin/schoolCodes';
import { likeContains, notFound, regionParam, scopeOf, uuidId } from '../../services/admin/scope';
import { deleteListing } from '../../services/listings/lifecycle';
import { cancelOpenOrdersForListing } from '../../services/orders/cancel';
import { ACTIVE_ORDER_STATUSES } from '../../services/orders/transitions';
import { schoolSearch } from './schools';

/** Listing administration. */
export const listingRoutes = new Hono<AppEnv>();

const LISTING_STATUSES = ['active', 'reserved', 'sold', 'removed'] as const;
/** Minimum length of a platform cancel reason. */
export const PLATFORM_CANCEL_REASON_MIN_LENGTH = 3;

function listingSelect(db: Database) {
  return db
    .select({
      l: listings,
      bookTitle: books.title,
      sellerEmail: users.email,
      schoolCode: schools.code,
      schoolName: schools.name,
      schoolTranslations: schools.translations,
    })
    .from(listings)
    .innerJoin(books, eq(books.id, listings.bookId))
    .innerJoin(users, eq(users.id, listings.sellerId))
    .leftJoin(schools, eq(schools.id, listings.schoolId));
}

type ListingRow = Awaited<ReturnType<ReturnType<typeof listingSelect>['limit']>>[number];

export function listingJson(row: ListingRow, lang: string | null) {
  const l = row.l;
  return {
    id: l.id,
    book: { id: l.bookId, title: row.bookTitle },
    seller: { id: l.sellerId, email: row.sellerEmail },
    school:
      l.schoolId === null || row.schoolName === null
        ? null
        : {
            id: l.schoolId,
            code: row.schoolCode,
            name: row.schoolName,
            display_name: lang ? localized(row.schoolTranslations, lang, 'name', row.schoolName) : row.schoolName,
          },
    region: l.regionCode,
    price: l.price,
    currency: l.currencyCode,
    condition: l.condition,
    status: l.status,
    created_at: l.createdAt,
    admin_locked: !!l.adminLocked,
    admin_lock_reason: l.adminLockReason,
    locked_by: l.lockedById,
    locked_at: l.lockedAt,
  };
}

function scopeWhere(scope: string[] | null): SQL | undefined {
  if (scope === null) return undefined;
  return scope.length ? inArray(listings.regionCode, scope) : sql`0`;
}

/** Title or authors contain q, or the ISBN contains it without hyphens/spaces. */
export function bookSearch(q: string): SQL {
  const like = likeContains(q);
  const digits = q.replace(/[- ]/g, '');
  const parts = [sql`${books.title} LIKE ${like} ESCAPE '\\'`, sql`${books.authors} LIKE ${like} ESCAPE '\\'`];
  if (digits) parts.push(sql`${books.isbn13} LIKE ${likeContains(digits)} ESCAPE '\\'`);
  return sql`(${sql.join(parts, sql` OR `)})`;
}

listingRoutes.get('/listings/', async (c) => {
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url);
  const conds: (SQL | undefined)[] = [scopeWhere(await scopeOf(c))];
  const q = c.req.query('q');
  if (q) {
    const like = likeContains(q);
    conds.push(sql`(
      ${bookSearch(q)}
      OR ${listings.courseName} LIKE ${like} ESCAPE '\\'
      OR ${listings.professorName} LIKE ${like} ESCAPE '\\'
      OR ${users.email} LIKE ${like} ESCAPE '\\'
      OR (${schools.id} IS NOT NULL AND ${schoolSearch(q)})
    )`);
  }
  const status = c.req.query('status');
  if (status) conds.push(sql`${listings.status} = ${status}`);
  const condition = c.req.query('condition');
  if (condition) conds.push(sql`${listings.condition} = ${condition}`);
  const school = c.req.query('school');
  if (school) {
    const id = await adminSchoolFilterId(db, (await getRegion(c))?.code ?? null, school);
    conds.push(eq(listings.schoolId, id ?? 0));
  }
  const region = regionParam(c);
  if (region) conds.push(eq(listings.regionCode, region));
  const where = and(...conds);
  const [{ n }] = await db
    .select({ n: count() })
    .from(listings)
    .innerJoin(books, eq(books.id, listings.bookId))
    .innerJoin(users, eq(users.id, listings.sellerId))
    .leftJoin(schools, eq(schools.id, listings.schoolId))
    .where(where);
  const rows = await listingSelect(db)
    .where(where)
    .orderBy(desc(listings.createdAt), desc(listings.id))
    .limit(page.limit)
    .offset(page.offset);
  const lang = await resolveLanguage(c);
  return c.json(
    page.wrap(
      rows.map((r) => listingJson(r, lang)),
      n,
    ),
  );
});

async function loadListing(c: Context<AppEnv>, db: Database): Promise<ListingRow> {
  const id = uuidId(c.req.param('id'));
  const [row] = await listingSelect(db)
    .where(and(eq(listings.id, id), scopeWhere(await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

listingRoutes.get('/listings/:id/', async (c) => {
  const db = createDb(c.env.DB);
  return c.json(listingJson(await loadListing(c, db), await resolveLanguage(c)));
});

listingRoutes.patch('/listings/:id/', async (c) => {
  const data = await readJson(c.req);
  const allowed = new Set(['status', 'admin_locked', 'admin_lock_reason']);
  if (Object.keys(data).some((k) => !allowed.has(k))) apiError(400, 'admin.errForbiddenField');
  if (!('status' in data) && !('admin_locked' in data)) apiError(400, 'admin.errInvalidField');

  const db = createDb(c.env.DB);
  const row = await loadListing(c, db);
  const l = row.l;
  const me = c.get('user')!;
  const set: Partial<typeof listings.$inferInsert> = {};
  const audits: ReturnType<typeof auditInsert>[] = [];

  let statusChanged = false;
  let newStatus = l.status;
  if ('status' in data) {
    const s = data.status;
    if (typeof s !== 'string' || !(LISTING_STATUSES as readonly string[]).includes(s)) apiError(400, 'admin.errInvalidStatus');
    if (s !== l.status) {
      newStatus = s as (typeof LISTING_STATUSES)[number];
      set.status = newStatus;
      statusChanged = true;
      audits.push(
        auditInsert(
          db,
          {
            actorId: me.id,
            kind: 'admin.listing_status_changed',
            meta: { listing_id: l.id, old_status: l.status, new_status: newStatus },
            targetType: 'listing',
            targetId: l.id,
          },
          c,
        ),
      );
    }
  }

  // Taking a listing down locks it, or the seller could put it straight back.
  let newLocked: boolean;
  if ('admin_locked' in data) {
    if (typeof data.admin_locked !== 'boolean') apiError(400, 'admin.errInvalidField');
    newLocked = data.admin_locked;
  } else if (statusChanged && newStatus === 'removed') {
    newLocked = true;
  } else {
    newLocked = !!l.adminLocked;
  }
  if (newLocked !== !!l.adminLocked) {
    set.adminLocked = newLocked ? 1 : 0;
    if (newLocked) {
      set.adminLockReason = String(data.admin_lock_reason ?? '').slice(0, 255);
      set.lockedById = me.id;
      set.lockedAt = new Date().toISOString();
    } else {
      set.adminLockReason = '';
      set.lockedById = null;
      set.lockedAt = null;
    }
    audits.push(
      auditInsert(
        db,
        {
          actorId: me.id,
          kind: newLocked ? 'admin.listing_locked' : 'admin.listing_unlocked',
          meta: { listing_id: l.id },
          targetType: 'listing',
          targetId: l.id,
        },
        c,
      ),
    );
  }

  if (Object.keys(set).length) {
    set.updatedAt = new Date().toISOString();
    await db.batch([db.update(listings).set(set).where(eq(listings.id, l.id)), ...audits]);
  }
  const fresh = await loadListing(c, db);
  return c.json(listingJson(fresh, null));
});

listingRoutes.delete('/listings/:id/', async (c) => {
  const db = createDb(c.env.DB);
  const row = await loadListing(c, db);
  const l = row.l;
  const me = c.get('user')!;
  const body = await readJson(c.req);
  const rawReason = typeof body.reason === 'string' && body.reason ? body.reason : (c.req.query('reason') ?? '');
  const reason = rawReason.trim();

  const [{ n: openOrders }] = await db
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.listingId, l.id), inArray(orders.status, [...ACTIVE_ORDER_STATUSES])));
  if (openOrders && reason.length < PLATFORM_CANCEL_REASON_MIN_LENGTH) {
    throw new HTTPException(400, {
      res: Response.json({ error: { code: 'admin.errInvalidReason' }, open_orders: openOrders }, { status: 400 }),
    });
  }

  // Open orders are cancelled on the platform's behalf (each through its
  // order lock, with its own audit event and chat notice) before the listing
  // goes; finished orders keep their snapshot.
  if (openOrders) {
    await cancelOpenOrdersForListing(c.env, { listingId: l.id, actorId: me.id, reason: 'admin_removed', note: reason });
  }
  await writeAudit(
    db,
    {
      actorId: me.id,
      kind: 'admin.listing_deleted',
      meta: {
        listing_id: l.id,
        seller_id: l.sellerId,
        book_title: row.bookTitle,
        status: l.status,
        admin_locked: !!l.adminLocked,
        admin_lock_reason: l.adminLockReason,
      },
      targetType: 'listing',
      targetId: l.id,
    },
    c,
  );
  await deleteListing(c.env, new URL(c.req.url).origin, { id: l.id, bookId: l.bookId, sellerId: l.sellerId, photos: l.photos });
  return c.body(null, 204);
});
