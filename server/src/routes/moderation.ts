import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { cancelOpenOrdersForListing } from '../services/orders/cancel';
import { authMiddleware, requireStaff } from '../middleware/auth';
import { apiError, fieldErrors, pagination, readJson, validate } from '../lib/http';
import { requireRegion, isVerifiedIn } from '../lib/region';
import { managedRegionCodes } from '../services/messaging/staffScope';
import { getConversation, isParticipant } from '../services/messaging/conversations';
import { UUID_LOOSE_RE } from '../lib/uuid';
import { notFound } from '../services/admin/scope';
import { checkRate } from '../middleware/rateLimit';

/**
 * /api/v1/moderation/: listing reports and chat
 * reports, filed by users and reviewed by staff (scoped to the regions they
 * manage; superusers see all).
 */
export const moderationRoutes = new Hono<AppEnv>();
moderationRoutes.use('*', authMiddleware());

const MAX_DETAIL = 5000;
const MAX_FLAGGED = 200;

function invalidPage(): never {
  throw new HTTPException(404, { res: Response.json({ detail: 'Invalid page.' }, { status: 404 }), message: 'invalid page' });
}

/** `AND <col> IN (...)` for a staff scope; null scope = superuser = everything. */
function scopeClause(col: string, scope: string[] | null): { sql: string; args: string[] } {
  if (scope === null) return { sql: '', args: [] };
  if (!scope.length) return { sql: ' AND 0', args: [] };
  return { sql: ` AND ${col} IN (${scope.map(() => '?').join(',')})`, args: scope };
}

const optionalStatus = (c: Context<AppEnv>) => c.req.query('status') || '';
const optionalRegion = (c: Context<AppEnv>) => (c.req.query('region') ?? '').trim().toUpperCase();

const TRANSITIONS: Record<string, string[]> = { open: ['actioned', 'dismissed'], actioned: [], dismissed: [] };

/** The requested new status, or 400 {"status": ["admin.errReportAlreadyResolved"]}. */
function nextStatus(body: Record<string, unknown>, current: string): 'actioned' | 'dismissed' {
  const value = body.status;
  if (typeof value !== 'string' || !(TRANSITIONS[current] ?? []).includes(value)) {
    fieldErrors({ status: ['admin.errReportAlreadyResolved'] });
  }
  return value as 'actioned' | 'dismissed';
}

function audit(c: Context<AppEnv>, kind: string, targetType: string, targetId: string, meta: Record<string, unknown>) {
  return c.env.DB.prepare(
    `INSERT INTO audit_events (actor_id, action, target_type, target_id, ip_address, user_agent, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    c.get('user')!.id,
    kind,
    targetType,
    targetId,
    c.req.header('CF-Connecting-IP') ?? null,
    c.req.header('User-Agent')?.slice(0, 255) ?? null,
    JSON.stringify(meta),
    new Date().toISOString(),
  );
}

// ─── Listing reports ──────────────────────────────────────────────────────

interface ReportRow {
  id: string;
  reporter_id: string;
  reporter_email: string | null;
  listing_id: string | null;
  listing_ref: string | null;
  book_title: string;
  region_code: string | null;
  reason: string;
  detail: string;
  status: string;
  created_at: string;
}

const REPORT_SELECT = `SELECT r.id, r.reporter_id, u.email AS reporter_email, r.listing_id, r.listing_ref, r.book_title,
                              r.region_code, r.reason, r.detail, r.status, r.created_at
                         FROM reports r LEFT JOIN users u ON u.id = r.reporter_id`;

/** A listing report as the app reads it. */
const serializeReport = (r: ReportRow) => ({
  id: r.id,
  listing: { id: r.listing_ref, title: r.book_title, deleted: r.listing_id === null },
  reporter: { id: r.reporter_id, email: r.reporter_email ?? '' },
  reason: r.reason,
  detail: r.detail,
  status: r.status,
  created_at: r.created_at,
});

async function reportPage(c: Context<AppEnv>, where: string, args: unknown[]) {
  const page = pagination(c.req.url);
  const [countRow, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM reports r WHERE ${where}`)
      .bind(...args)
      .first<{ n: number }>(),
    c.env.DB.prepare(`${REPORT_SELECT} WHERE ${where} ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?`)
      .bind(...args, page.limit, page.offset)
      .all<ReportRow>(),
  ]);
  if (page.page > 1 && !rows.results.length) invalidPage();
  return c.json(page.wrap(rows.results.map(serializeReport), countRow?.n ?? 0));
}

const reportCreateSchema = z.object({
  reason: z.enum(['fake', 'scam', 'other'], { message: 'moderation.errInvalidReason' }),
  detail: z.string().max(MAX_DETAIL, 'common.errValidation').optional().default(''),
});

/** POST '' — file a listing report (signed in, verified in the listing's region). */
moderationRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  await checkRate(c, 'report', '20/hour');
  const body = await readJson(c.req);
  const listingId = typeof body.listing === 'string' ? body.listing : '';

  // Must be verified in the listing's region when it exists, else the request's.
  const target =
    listingId && UUID_LOOSE_RE.test(listingId)
      ? await c.env.DB.prepare('SELECT region_code FROM listings WHERE id = ?').bind(listingId).first<{ region_code: string }>()
      : null;
  const region = await requireRegion(c);
  const verifyIn = target?.region_code ?? region.code;
  if (!(await isVerifiedIn(c.env, user.id, verifyIn))) apiError(403, 'acct.errUnverifiedInRegion', { region: verifyIn });

  if (!listingId || !UUID_LOOSE_RE.test(listingId)) notFound();
  const listing = await c.env.DB.prepare(
    `SELECT l.id, l.seller_id, l.region_code, b.title AS book_title
       FROM listings l LEFT JOIN books b ON b.id = l.book_id
      WHERE l.id = ? AND l.region_code = ?`,
  )
    .bind(listingId, region.code)
    .first<{ id: string; seller_id: string; region_code: string; book_title: string | null }>();
  if (!listing) notFound();
  if (listing.seller_id === user.id) apiError(400, 'moderation.errCannotReportOwnListing');

  const pending = await c.env.DB.prepare("SELECT 1 FROM reports WHERE reporter_id = ? AND listing_id = ? AND status = 'open' LIMIT 1")
    .bind(user.id, listing.id)
    .first();
  if (pending) apiError(400, 'moderation.errAlreadyReported');

  const data = validate(reportCreateSchema, body);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, listing_id, seller_id, region_code, listing_ref, book_title, reason, detail, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(
      id,
      user.id,
      listing.id,
      listing.seller_id,
      listing.region_code,
      listing.id,
      (listing.book_title ?? '').slice(0, 255),
      data.reason,
      data.detail,
      now,
    )
    .run();

  return c.json({ id, listing: listing.id, reason: data.reason, detail: data.detail, status: 'open', created_at: now }, 201);
});

/** GET mine/ — the user's own reports in the request's region. */
moderationRoutes.get('/mine/', async (c) => {
  const region = await requireRegion(c);
  return reportPage(c, 'r.reporter_id = ? AND r.region_code = ?', [c.get('user')!.id, region.code]);
});

/** GET all/ — staff, scoped to managed regions; ?status= and ?region= filters. */
moderationRoutes.get('/all/', requireStaff(), async (c) => {
  const scope = scopeClause('r.region_code', await managedRegionCodes(c.env, c.get('user')!));
  let where = `1${scope.sql}`;
  const args: unknown[] = [...scope.args];
  const status = optionalStatus(c);
  if (status) {
    where += ' AND r.status = ?';
    args.push(status);
  }
  const region = optionalRegion(c);
  if (region) {
    where += ' AND r.region_code = ?';
    args.push(region);
  }
  return reportPage(c, where, args);
});

// ─── Chat reports ─────────────────────────────────────────────────────────

interface ChatReportRow {
  id: string;
  conversation_id: string;
  conv_title: string | null;
  conv_listing_id: string | null;
  reporter_id: string;
  reporter_email: string | null;
  reported_party_id: string;
  reported_email: string | null;
  region_code: string;
  reason: string;
  detail: string;
  status: string;
  flagged_message_ids: string;
  created_at: string;
}

const CHAT_REPORT_SELECT = `SELECT cr.id, cr.conversation_id, cv.book_title AS conv_title, cv.listing_id AS conv_listing_id,
                                   cr.reporter_id, ru.email AS reporter_email, cr.reported_party_id, pu.email AS reported_email,
                                   cr.region_code, cr.reason, cr.detail, cr.status, cr.flagged_message_ids, cr.created_at
                              FROM chat_reports cr
                              LEFT JOIN conversations cv ON cv.id = cr.conversation_id
                              LEFT JOIN users ru ON ru.id = cr.reporter_id
                              LEFT JOIN users pu ON pu.id = cr.reported_party_id`;

function parseIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** A chat report as the app reads it. */
const serializeChatReport = (r: ChatReportRow) => ({
  id: r.id,
  conversation: { id: r.conversation_id, listing_title: r.conv_title ?? '', listing_deleted: r.conv_listing_id === null },
  reporter: { id: r.reporter_id, email: r.reporter_email ?? '' },
  reported_party: { id: r.reported_party_id, email: r.reported_email ?? '' },
  reason: r.reason,
  detail: r.detail,
  flagged_message_ids: parseIds(r.flagged_message_ids),
  status: r.status,
  created_at: r.created_at,
});

async function chatReportPage(c: Context<AppEnv>, where: string, args: unknown[]) {
  const page = pagination(c.req.url);
  const [countRow, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM chat_reports cr WHERE ${where}`)
      .bind(...args)
      .first<{ n: number }>(),
    c.env.DB.prepare(`${CHAT_REPORT_SELECT} WHERE ${where} ORDER BY cr.created_at DESC, cr.id LIMIT ? OFFSET ?`)
      .bind(...args, page.limit, page.offset)
      .all<ChatReportRow>(),
  ]);
  if (page.page > 1 && !rows.results.length) invalidPage();
  return c.json(page.wrap(rows.results.map(serializeChatReport), countRow?.n ?? 0));
}

const chatReportCreateSchema = z.object({
  reason: z.enum(['harassment', 'scam', 'spam', 'other'], { message: 'moderation.errInvalidReason' }),
  detail: z.string().max(MAX_DETAIL, 'common.errValidation').optional().default(''),
  flagged_message_ids: z
    .array(z.string().max(64, 'common.errValidation'), { message: 'common.errValidation' })
    .max(MAX_FLAGGED, 'common.errValidation')
    .optional()
    .default([]),
});

/** POST chat-reports/. */
moderationRoutes.post('/chat-reports/', async (c) => {
  const user = c.get('user')!;
  await checkRate(c, 'report', '20/hour');
  const body = await readJson(c.req);
  const conversationId = typeof body.conversation === 'string' ? body.conversation : '';
  if (!conversationId || !UUID_LOOSE_RE.test(conversationId)) apiError(400, 'invalid.conversationRequired');

  // Keyed on the conversation, not the request region (the row stores the conversation's region).
  await requireRegion(c);
  const pending = await c.env.DB.prepare(
    "SELECT 1 FROM chat_reports WHERE reporter_id = ? AND conversation_id = ? AND status = 'open' LIMIT 1",
  )
    .bind(user.id, conversationId)
    .first();
  if (pending) apiError(400, 'moderation.errAlreadyReported');

  const conv = await getConversation(c.env, conversationId);
  if (!conv) fieldErrors({ conversation: ['msg.errConversationNotFound'] });
  if (!isParticipant(conv, user.id)) fieldErrors({ conversation: ['msg.errNotParticipant'] });
  // The reported party is whoever the reporter is talking to, never a
  // client-chosen user id.
  const otherId = conv.buyer_id === user.id ? conv.seller_id : conv.buyer_id;
  const reported = body.reported_party;
  if (reported === undefined || reported === null || reported === '') fieldErrors({ reported_party: ['common.errValidation'] });
  if (String(reported) !== otherId) fieldErrors({ reported_party: ['moderation.errInvalidReportedParty'] });

  const data = validate(chatReportCreateSchema, body);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO chat_reports (id, reporter_id, conversation_id, region_code, reported_party_id, reason, detail, status, flagged_message_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(id, user.id, conv.id, conv.region_code, otherId, data.reason, data.detail, JSON.stringify(data.flagged_message_ids), now)
    .run();

  return c.json(
    {
      id,
      conversation: conv.id,
      reported_party: otherId,
      reason: data.reason,
      detail: data.detail,
      flagged_message_ids: data.flagged_message_ids,
      status: 'open',
      created_at: now,
    },
    201,
  );
});

moderationRoutes.get('/chat-reports/mine/', async (c) => {
  const region = await requireRegion(c);
  return chatReportPage(c, 'cr.reporter_id = ? AND cr.region_code = ?', [c.get('user')!.id, region.code]);
});

moderationRoutes.get('/chat-reports/all/', requireStaff(), async (c) => {
  const scope = scopeClause('cr.region_code', await managedRegionCodes(c.env, c.get('user')!));
  let where = `1${scope.sql}`;
  const args: unknown[] = [...scope.args];
  const status = optionalStatus(c);
  if (status) {
    where += ' AND cr.status = ?';
    args.push(status);
  }
  const region = optionalRegion(c);
  if (region) {
    where += ' AND cr.region_code = ?';
    args.push(region);
  }
  return chatReportPage(c, where, args);
});

/** A chat report the current staff member may see, or 404. */
async function scopedChatReport(c: Context<AppEnv>, id: string): Promise<ChatReportRow> {
  if (!UUID_LOOSE_RE.test(id)) notFound();
  const scope = scopeClause('cr.region_code', await managedRegionCodes(c.env, c.get('user')!));
  const row = await c.env.DB.prepare(`${CHAT_REPORT_SELECT} WHERE cr.id = ?${scope.sql}`)
    .bind(id, ...scope.args)
    .first<ChatReportRow>();
  if (!row) notFound();
  return row;
}

moderationRoutes.get('/chat-reports/:id/', requireStaff(), async (c) => {
  return c.json(serializeChatReport(await scopedChatReport(c, c.req.param('id'))));
});

moderationRoutes.patch('/chat-reports/:id/action/', requireStaff(), async (c) => {
  const report = await scopedChatReport(c, c.req.param('id'));
  const status = nextStatus(await readJson(c.req), report.status);
  const res = await c.env.DB.prepare("UPDATE chat_reports SET status = ? WHERE id = ? AND status = 'open'").bind(status, report.id).run();
  if (!res.meta.changes) fieldErrors({ status: ['admin.errReportAlreadyResolved'] });
  await audit(c, 'admin.chat_report_actioned', 'chat_report', report.id, {
    chat_report_id: report.id,
    action: status,
    conversation_id: report.conversation_id,
  }).run();
  return c.json(serializeChatReport(await scopedChatReport(c, report.id)));
});

// ─── Listing report action ────────────────────────────────────────────────

moderationRoutes.patch('/:id/', requireStaff(), async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  if (!UUID_LOOSE_RE.test(id)) notFound();
  const scope = scopeClause('r.region_code', await managedRegionCodes(c.env, user));
  const report = await c.env.DB.prepare(`${REPORT_SELECT} WHERE r.id = ?${scope.sql}`)
    .bind(id, ...scope.args)
    .first<ReportRow>();
  if (!report) notFound();
  const status = nextStatus(await readJson(c.req), report.status);

  // Claim the report first, so two staff cannot action it twice.
  const res = await c.env.DB.prepare("UPDATE reports SET status = ? WHERE id = ? AND status = 'open'").bind(status, id).run();
  if (!res.meta.changes) fieldErrors({ status: ['admin.errReportAlreadyResolved'] });
  const reopen = () => c.env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind('open', id).run();

  const now = new Date().toISOString();
  const stmts = [];
  // Actioned takes the listing down, locked like an admin removal so the
  // seller cannot PATCH it back to active. Its open orders are cancelled
  // first, each with a notice, so no buyer is left arranging a meetup on a
  // listing taken down as a scam. Nothing to do if the listing is gone.
  if (status === 'actioned' && report.listing_id) {
    try {
      await cancelOpenOrdersForListing(c.env, {
        listingId: report.listing_id,
        actorId: user.id,
        reason: 'admin_removed',
        note: `report: ${report.reason}`,
      });
    } catch (e) {
      await reopen().catch(() => undefined);
      throw e;
    }
    stmts.push(
      c.env.DB.prepare(
        `UPDATE listings SET status = 'removed', admin_locked = 1, admin_lock_reason = ?, locked_by_id = ?, locked_at = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(`report: ${report.reason}`, user.id, now, now, report.listing_id),
    );
  }
  stmts.push(
    audit(c, 'admin.report_actioned', 'report', id, {
      report_id: id,
      action: status,
      listing_id: status === 'actioned' ? report.listing_id : null,
    }),
  );
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    // The takedown did not happen: give the report back so it can be actioned again.
    await reopen().catch(() => undefined);
    throw e;
  }

  const fresh = await c.env.DB.prepare(`${REPORT_SELECT} WHERE r.id = ?`).bind(id).first<ReportRow>();
  return c.json(serializeReport(fresh!));
});
