import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppEnv } from '../../env';
import { books, createDb, listings, orders, users, type Database } from '../../db';
import { apiError, pagination, readJson } from '../../lib/http';
import { likeContains, notFound, regionParam, scopeOf, scopeWhere, uuidId } from '../../services/admin/scope';
import { forceCancelOrder } from '../../services/orders/cancel';
import { bookSearch, PLATFORM_CANCEL_REASON_MIN_LENGTH } from './listings';

/**
 * Read-only list/detail plus force-cancel.
 */
export const orderRoutes = new Hono<AppEnv>();

const buyer = alias(users, 'buyer');
const seller = alias(users, 'seller');

function orderSelect(db: Database) {
  return db
    .select({ o: orders, buyerEmail: buyer.email, sellerEmail: seller.email })
    .from(orders)
    .innerJoin(buyer, eq(buyer.id, orders.buyerId))
    .innerJoin(seller, eq(seller.id, orders.sellerId));
}

type OrderRow = Awaited<ReturnType<ReturnType<typeof orderSelect>['limit']>>[number];

export function orderJson(row: OrderRow) {
  const o = row.o;
  return {
    id: o.id,
    buyer: { id: o.buyerId, email: row.buyerEmail },
    seller: { id: o.sellerId, email: row.sellerEmail },
    // From the snapshot: the order outlives a deleted listing.
    listing: { id: String(o.listingRef ?? o.listingId ?? ''), book_title: o.bookTitle, deleted: o.listingId === null },
    region: o.regionCode,
    status: o.status,
    total_amount: o.totalAmount,
    currency: o.currencyCode,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  };
}

orderRoutes.get('/orders', async (c) => {
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url);
  const conds: (SQL | undefined)[] = [scopeWhere(orders.regionCode, await scopeOf(c))];
  const q = c.req.query('q');
  if (q) {
    const qClean = q.replace(/^#+/, '').trim();
    const like = likeContains(q);
    const parts: SQL[] = [
      sql`${orders.id} LIKE ${likeContains(qClean)} ESCAPE '\\'`,
      sql`${buyer.email} LIKE ${like} ESCAPE '\\'`,
      sql`${seller.email} LIKE ${like} ESCAPE '\\'`,
      sql`${orders.bookTitle} LIKE ${like} ESCAPE '\\'`,
      sql`EXISTS (SELECT 1 FROM ${listings} JOIN ${books} ON ${books.id} = ${listings.bookId}
                  WHERE ${listings.id} = ${orders.listingId} AND ${bookSearch(q)})`,
    ];
    const digits = q.replace(/[- ]/g, '');
    if (digits) parts.push(sql`${orders.bookIsbn} LIKE ${likeContains(digits)} ESCAPE '\\'`);
    conds.push(sql`(${sql.join(parts, sql` OR `)})`);
  }
  const status = c.req.query('status');
  if (status) conds.push(sql`${orders.status} = ${status}`);
  const region = regionParam(c);
  if (region) conds.push(eq(orders.regionCode, region));
  const where = and(...conds);
  const [{ n }] = await db
    .select({ n: count() })
    .from(orders)
    .innerJoin(buyer, eq(buyer.id, orders.buyerId))
    .innerJoin(seller, eq(seller.id, orders.sellerId))
    .where(where);
  const rows = await orderSelect(db).where(where).orderBy(desc(orders.createdAt), desc(orders.id)).limit(page.limit).offset(page.offset);
  return c.json(page.wrap(rows.map(orderJson), n));
});

async function loadOrder(c: Context<AppEnv>, db: Database, id: string): Promise<OrderRow> {
  const [row] = await orderSelect(db)
    .where(and(eq(orders.id, id), scopeWhere(orders.regionCode, await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

orderRoutes.get('/orders/:id', async (c) => {
  const db = createDb(c.env.DB);
  return c.json(orderJson(await loadOrder(c, db, uuidId(c.req.param('id')))));
});

orderRoutes.post('/orders/:id/force-cancel', async (c) => {
  const db = createDb(c.env.DB);
  const id = uuidId(c.req.param('id'));
  const order = await loadOrder(c, db, id);
  const data = await readJson(c.req);
  const reason = (typeof data.reason === 'string' ? data.reason : '').trim();
  if (reason.length < PLATFORM_CANCEL_REASON_MIN_LENGTH) apiError(400, 'admin.errInvalidReason');
  if (order.o.status === 'cancelled' || order.o.status === 'completed') apiError(400, 'admin.errOrderAlreadyFinal');
  // Under the order lock: 400 admin.errOrderAlreadyFinal if a party finished
  // it meanwhile; writes the audit event and posts the chat notice.
  await forceCancelOrder(c.env, { orderId: id, actorId: c.get('user')!.id, reason });
  return c.json(orderJson(await loadOrder(c, db, id)));
});
