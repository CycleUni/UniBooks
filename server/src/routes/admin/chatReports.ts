import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppEnv } from '../../env';
import { chatReports, conversations, createDb, users, type Database } from '../../db';
import { apiError, pagination, readJson } from '../../lib/http';
import { writeAudit } from '../../services/admin/audit';
import { notFound, regionParam, scopeOf, scopeWhere, uuidId } from '../../services/admin/scope';
import { mintChatToken } from '../../services/chatTokens';

/** Chat report review. */
export const chatReportRoutes = new Hono<AppEnv>();

const reporter = alias(users, 'reporter');
const reported = alias(users, 'reported_party');

function reportSelect(db: Database) {
  return db
    .select({
      r: chatReports,
      bookTitle: conversations.bookTitle,
      convRegion: conversations.regionCode,
      buyerId: conversations.buyerId,
      sellerId: conversations.sellerId,
      reporterEmail: reporter.email,
      reportedEmail: reported.email,
    })
    .from(chatReports)
    .innerJoin(conversations, eq(conversations.id, chatReports.conversationId))
    .innerJoin(reporter, eq(reporter.id, chatReports.reporterId))
    .innerJoin(reported, eq(reported.id, chatReports.reportedPartyId));
}

type ReportRow = Awaited<ReturnType<ReturnType<typeof reportSelect>['limit']>>[number];

function reportJson(row: ReportRow) {
  const r = row.r;
  return {
    id: r.id,
    conversation_id: String(r.conversationId),
    listing_title: row.bookTitle,
    reporter_email: row.reporterEmail,
    reported_party_email: row.reportedEmail,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    created_at: r.createdAt,
    // The conversation's region: the same path the scope filters on.
    region: row.convRegion,
  };
}

chatReportRoutes.get('/chat-reports', async (c) => {
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url);
  const conds: (SQL | undefined)[] = [scopeWhere(conversations.regionCode, await scopeOf(c))];
  const status = c.req.query('status');
  if (status) conds.push(sql`${chatReports.status} = ${status}`);
  const region = regionParam(c);
  if (region) conds.push(eq(conversations.regionCode, region));
  const where = and(...conds);
  const [{ n }] = await db
    .select({ n: count() })
    .from(chatReports)
    .innerJoin(conversations, eq(conversations.id, chatReports.conversationId))
    .where(where);
  const rows = await reportSelect(db)
    .where(where)
    .orderBy(desc(chatReports.createdAt), desc(chatReports.id))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(page.wrap(rows.map(reportJson), n));
});

async function loadReport(c: Context<AppEnv>, db: Database): Promise<ReportRow> {
  const id = uuidId(c.req.param('id'));
  const [row] = await reportSelect(db)
    .where(and(eq(chatReports.id, id), scopeWhere(conversations.regionCode, await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

chatReportRoutes.get('/chat-reports/:id', async (c) => c.json(reportJson(await loadReport(c, createDb(c.env.DB)))));

chatReportRoutes.patch('/chat-reports/:id', async (c) => {
  const data = await readJson(c.req);
  if (Object.keys(data).some((k) => k !== 'status')) apiError(400, 'admin.errForbiddenField');
  if (!('status' in data)) apiError(400, 'admin.errInvalidField');
  const newStatus = data.status;
  if (newStatus !== 'open' && newStatus !== 'actioned' && newStatus !== 'dismissed') apiError(400, 'admin.errInvalidStatus');
  const db = createDb(c.env.DB);
  const row = await loadReport(c, db);
  await db.update(chatReports).set({ status: newStatus }).where(eq(chatReports.id, row.r.id));
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'admin.chat_report_updated',
      meta: { chat_report_id: row.r.id, old_status: row.r.status, new_status: newStatus },
      targetType: 'chat_report',
      targetId: row.r.id,
    },
    c,
  );
  return c.json(reportJson({ ...row, r: { ...row.r, status: newStatus } }));
});

/**
 * A short-lived, read-only ('observer') room token so a moderator can read
 * the reported conversation. The chat is served by this same Worker, so the
 * chat URL is the request's own origin.
 */
chatReportRoutes.get('/chat-reports/:id/chat-token', async (c) => {
  const row = await loadReport(c, createDb(c.env.DB));
  const roomId = String(row.r.conversationId);
  const token = await mintChatToken(c.env, {
    userId: c.get('user')!.id,
    roomId,
    participantIds: [row.buyerId, row.sellerId],
    role: 'observer',
  });
  return c.json({ token, room_id: roomId });
});
