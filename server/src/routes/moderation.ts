import { Hono, type Context } from 'hono';
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import type { AppEnv } from '../env';
import {
  bookReports,
  books,
  chatReports,
  conversations,
  createDb,
  listings,
  reports,
  users,
  type BookReport,
  type ChatReport,
  type Database,
  type Report,
} from '../db';
import { cancelOpenOrdersForListing } from '../services/orders/cancel';
import { authMiddleware, requireStaff } from '../middleware/auth';
import { isUniqueViolation } from '../lib/db';
import { apiError, fieldErrors, pagination, readJson, validate } from '../lib/http';
import { LIMITS } from '../lib/limits';
import { requireRegion, assertMayTrade } from '../lib/region';
import { managedRegionCodes } from '../services/messaging/staffScope';
import { getConversation, isParticipant } from '../services/messaging/conversations';
import { UUID_LOOSE_RE } from '../lib/uuid';
import { notFound, scopeWhere } from '../services/admin/scope';
import { auditInsert } from '../services/admin/audit';
import { checkRate } from '../middleware/rateLimit';

/**
 * /api/v1/moderation/: listing reports and chat
 * reports, filed by users and reviewed by staff (scoped to the regions they
 * manage; admins see all).
 */
export const moderationRoutes = new Hono<AppEnv>();
moderationRoutes.use('*', authMiddleware());

const MAX_DETAIL = LIMITS.reportDetail;
const MAX_FLAGGED = 200;

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

function audit(c: Context<AppEnv>, db: Database, kind: string, targetType: string, targetId: string, meta: Record<string, unknown>) {
  return auditInsert(db, { actorId: c.get('user')!.id, kind, targetType, targetId, meta }, c);
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

function selectReports(db: Database) {
  return db
    .select({
      id: reports.id,
      reporter_id: reports.reporterId,
      reporter_email: users.email,
      listing_id: reports.listingId,
      listing_ref: reports.listingRef,
      book_title: reports.bookTitle,
      region_code: reports.regionCode,
      reason: reports.reason,
      detail: reports.detail,
      status: reports.status,
      created_at: reports.createdAt,
    })
    .from(reports)
    .leftJoin(users, eq(users.id, reports.reporterId));
}

/** A listing report as the app reads it. */
const serializeReport = (r: ReportRow) => ({
  id: r.id,
  region: r.region_code,
  listing: { id: r.listing_ref, title: r.book_title, deleted: r.listing_id === null },
  reporter: { id: r.reporter_id, email: r.reporter_email ?? '' },
  reason: r.reason,
  detail: r.detail,
  status: r.status,
  created_at: r.created_at,
});

async function reportPage(c: Context<AppEnv>, where: SQL | undefined) {
  const page = pagination(c.req.url);
  const db = createDb(c.env.DB);
  const [[countRow], rows] = await Promise.all([
    db.select({ n: count() }).from(reports).where(where),
    selectReports(db).where(where).orderBy(desc(reports.createdAt), asc(reports.id)).limit(page.limit).offset(page.offset),
  ]);
  return c.json(page.wrap(rows.map(serializeReport), countRow?.n ?? 0));
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
  const db = createDb(c.env.DB);

  // Must be verified in the listing's region when it exists, else the request's.
  const [target] =
    listingId && UUID_LOOSE_RE.test(listingId)
      ? await db.select({ regionCode: listings.regionCode }).from(listings).where(eq(listings.id, listingId)).limit(1)
      : [];
  const region = await requireRegion(c);
  const verifyIn = target?.regionCode ?? region.code;
  await assertMayTrade(c, verifyIn);

  if (!listingId || !UUID_LOOSE_RE.test(listingId)) notFound();
  const [listing] = await db
    .select({ id: listings.id, sellerId: listings.sellerId, regionCode: listings.regionCode, bookTitle: books.title })
    .from(listings)
    .leftJoin(books, eq(books.id, listings.bookId))
    .where(and(eq(listings.id, listingId), eq(listings.regionCode, region.code)))
    .limit(1);
  if (!listing) notFound();
  if (listing.sellerId === user.id) apiError(400, 'moderation.errCannotReportOwnListing');

  const [pending] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.reporterId, user.id), eq(reports.listingId, listing.id), eq(reports.status, 'open')))
    .limit(1);
  if (pending) apiError(400, 'moderation.errAlreadyReported');

  const data = validate(reportCreateSchema, body);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .insert(reports)
    .values({
      id,
      reporterId: user.id,
      listingId: listing.id,
      sellerId: listing.sellerId,
      regionCode: listing.regionCode,
      listingRef: listing.id,
      bookTitle: (listing.bookTitle ?? '').slice(0, 255),
      reason: data.reason,
      detail: data.detail,
      status: 'open',
      createdAt: now,
    })
    .run();

  return c.json({ id, listing: listing.id, reason: data.reason, detail: data.detail, status: 'open', created_at: now }, 201);
});

/** GET mine/ — the user's own reports in the request's region. */
moderationRoutes.get('/mine', async (c) => {
  const region = await requireRegion(c);
  return reportPage(c, and(eq(reports.reporterId, c.get('user')!.id), eq(reports.regionCode, region.code)));
});

/** GET all/ — staff, scoped to managed regions; ?status= and ?region= filters. */
moderationRoutes.get('/all', requireStaff(), async (c) => {
  const where = [scopeWhere(reports.regionCode, await managedRegionCodes(c.env, c.get('user')!))];
  const status = optionalStatus(c);
  if (status) where.push(eq(reports.status, status as Report['status']));
  const region = optionalRegion(c);
  if (region) where.push(eq(reports.regionCode, region));
  return reportPage(c, and(...where));
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

const chatReporter = alias(users, 'ru');
const chatReported = alias(users, 'pu');

function selectChatReports(db: Database) {
  return db
    .select({
      id: chatReports.id,
      conversation_id: chatReports.conversationId,
      conv_title: conversations.bookTitle,
      conv_listing_id: conversations.listingId,
      reporter_id: chatReports.reporterId,
      reporter_email: chatReporter.email,
      reported_party_id: chatReports.reportedPartyId,
      reported_email: chatReported.email,
      region_code: chatReports.regionCode,
      reason: chatReports.reason,
      detail: chatReports.detail,
      status: chatReports.status,
      flagged_message_ids: chatReports.flaggedMessageIds,
      created_at: chatReports.createdAt,
    })
    .from(chatReports)
    .leftJoin(conversations, eq(conversations.id, chatReports.conversationId))
    .leftJoin(chatReporter, eq(chatReporter.id, chatReports.reporterId))
    .leftJoin(chatReported, eq(chatReported.id, chatReports.reportedPartyId));
}

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

async function chatReportPage(c: Context<AppEnv>, where: SQL | undefined) {
  const page = pagination(c.req.url);
  const db = createDb(c.env.DB);
  const [[countRow], rows] = await Promise.all([
    db.select({ n: count() }).from(chatReports).where(where),
    selectChatReports(db).where(where).orderBy(desc(chatReports.createdAt), asc(chatReports.id)).limit(page.limit).offset(page.offset),
  ]);
  return c.json(page.wrap(rows.map(serializeChatReport), countRow?.n ?? 0));
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
moderationRoutes.post('/chat-reports', async (c) => {
  const user = c.get('user')!;
  await checkRate(c, 'report', '20/hour');
  const body = await readJson(c.req);
  const conversationId = typeof body.conversation === 'string' ? body.conversation : '';
  if (!conversationId || !UUID_LOOSE_RE.test(conversationId)) apiError(400, 'invalid.conversationRequired');

  // Keyed on the conversation, not the request region (the row stores the conversation's region).
  await requireRegion(c);
  const db = createDb(c.env.DB);
  const [pending] = await db
    .select({ id: chatReports.id })
    .from(chatReports)
    .where(and(eq(chatReports.reporterId, user.id), eq(chatReports.conversationId, conversationId), eq(chatReports.status, 'open')))
    .limit(1);
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
  await db
    .insert(chatReports)
    .values({
      id,
      reporterId: user.id,
      conversationId: conv.id,
      regionCode: conv.region_code,
      reportedPartyId: otherId,
      reason: data.reason,
      detail: data.detail,
      status: 'open',
      flaggedMessageIds: JSON.stringify(data.flagged_message_ids),
      createdAt: now,
    })
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

moderationRoutes.get('/chat-reports/mine', async (c) => {
  const region = await requireRegion(c);
  return chatReportPage(c, and(eq(chatReports.reporterId, c.get('user')!.id), eq(chatReports.regionCode, region.code)));
});

moderationRoutes.get('/chat-reports/all', requireStaff(), async (c) => {
  const where = [scopeWhere(chatReports.regionCode, await managedRegionCodes(c.env, c.get('user')!))];
  const status = optionalStatus(c);
  if (status) where.push(eq(chatReports.status, status as ChatReport['status']));
  const region = optionalRegion(c);
  if (region) where.push(eq(chatReports.regionCode, region));
  return chatReportPage(c, and(...where));
});

/** A chat report the current staff member may see, or 404. */
async function scopedChatReport(c: Context<AppEnv>, id: string): Promise<ChatReportRow> {
  if (!UUID_LOOSE_RE.test(id)) notFound();
  const scope = scopeWhere(chatReports.regionCode, await managedRegionCodes(c.env, c.get('user')!));
  const [row] = await selectChatReports(createDb(c.env.DB))
    .where(and(eq(chatReports.id, id), scope))
    .limit(1);
  if (!row) notFound();
  return row;
}

moderationRoutes.get('/chat-reports/:id', requireStaff(), async (c) => {
  return c.json(serializeChatReport(await scopedChatReport(c, c.req.param('id'))));
});

moderationRoutes.patch('/chat-reports/:id/action', requireStaff(), async (c) => {
  const report = await scopedChatReport(c, c.req.param('id'));
  const status = nextStatus(await readJson(c.req), report.status);
  const db = createDb(c.env.DB);
  const res = await db
    .update(chatReports)
    .set({ status })
    .where(and(eq(chatReports.id, report.id), eq(chatReports.status, 'open')))
    .run();
  if (!res.meta.changes) fieldErrors({ status: ['admin.errReportAlreadyResolved'] });
  await audit(c, db, 'admin.chat_report_actioned', 'chat_report', report.id, {
    chat_report_id: report.id,
    action: status,
    conversation_id: report.conversation_id,
  }).run();
  return c.json(serializeChatReport(await scopedChatReport(c, report.id)));
});

// ─── Listing report action ────────────────────────────────────────────────

moderationRoutes.patch('/:id', requireStaff(), async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  if (!UUID_LOOSE_RE.test(id)) notFound();
  const scope = scopeWhere(reports.regionCode, await managedRegionCodes(c.env, user));
  const db = createDb(c.env.DB);
  const [report] = await selectReports(db)
    .where(and(eq(reports.id, id), scope))
    .limit(1);
  if (!report) notFound();
  const status = nextStatus(await readJson(c.req), report.status);

  // Claim the report first, so two staff cannot action it twice.
  const res = await db
    .update(reports)
    .set({ status })
    .where(and(eq(reports.id, id), eq(reports.status, 'open')))
    .run();
  if (!res.meta.changes) fieldErrors({ status: ['admin.errReportAlreadyResolved'] });
  const reopen = () => db.update(reports).set({ status: 'open' }).where(eq(reports.id, id)).run();

  const now = new Date().toISOString();
  const stmts: Parameters<Database['batch']>[0][number][] = [];
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
      db
        .update(listings)
        .set({
          status: 'removed',
          adminLocked: 1,
          adminLockReason: `report: ${report.reason}`,
          lockedById: user.id,
          lockedAt: now,
          updatedAt: now,
        })
        .where(eq(listings.id, report.listing_id)),
    );
  }
  stmts.push(
    audit(c, db, 'admin.report_actioned', 'report', id, {
      report_id: id,
      action: status,
      listing_id: status === 'actioned' ? report.listing_id : null,
    }),
  );
  try {
    await db.batch(stmts as [(typeof stmts)[0], ...typeof stmts]);
  } catch (e) {
    // The takedown did not happen: give the report back so it can be actioned again.
    await reopen().catch(() => undefined);
    throw e;
  }

  const [fresh] = await selectReports(db).where(eq(reports.id, id)).limit(1);
  return c.json(serializeReport(fresh!));
});

// ─── Book reports ─────────────────────────────────────────────────────────

export const BOOK_REPORT_FIELDS = ['title', 'authors', 'publisher', 'published_date', 'cover', 'isbn', 'other'] as const;
export type BookReportField = (typeof BOOK_REPORT_FIELDS)[number];

const BOOK_REPORT_TRANSITIONS: Record<string, string[]> = { open: ['fixed', 'dismissed'], fixed: [], dismissed: [] };

function nextBookReportStatus(body: Record<string, unknown>, current: string): 'fixed' | 'dismissed' {
  const value = body.status;
  if (typeof value !== 'string' || !(BOOK_REPORT_TRANSITIONS[current] ?? []).includes(value)) {
    fieldErrors({ status: ['admin.errReportAlreadyResolved'] });
  }
  return value as 'fixed' | 'dismissed';
}

interface BookReportRow {
  id: string;
  book_id: string;
  book_title: string | null;
  book_authors: string | null;
  book_publisher: string | null;
  book_published_date: string | null;
  book_cover_url: string | null;
  book_isbn13: string | null;
  book_source: string | null;
  region_code: string;
  reporter_id: string;
  reporter_email: string | null;
  fields: string;
  detail: string;
  suggested: string | null;
  status: string;
  admin_note: string;
  resolved_by_id: string | null;
  resolved_by_email: string | null;
  resolved_at: string | null;
  created_at: string;
}

const reporterUser = alias(users, 'bru');
const resolverUser = alias(users, 'bsu');

function selectBookReports(db: Database) {
  return db
    .select({
      id: bookReports.id,
      book_id: bookReports.bookId,
      book_title: books.title,
      book_authors: books.authors,
      book_publisher: books.publisher,
      book_published_date: books.publishedDate,
      book_cover_url: books.coverUrl,
      book_isbn13: books.isbn13,
      book_source: books.source,
      region_code: bookReports.regionCode,
      reporter_id: bookReports.reporterId,
      reporter_email: reporterUser.email,
      fields: bookReports.fields,
      detail: bookReports.detail,
      suggested: bookReports.suggested,
      status: bookReports.status,
      admin_note: bookReports.adminNote,
      resolved_by_id: bookReports.resolvedById,
      resolved_by_email: resolverUser.email,
      resolved_at: bookReports.resolvedAt,
      created_at: bookReports.createdAt,
    })
    .from(bookReports)
    .leftJoin(books, eq(books.id, bookReports.bookId))
    .leftJoin(reporterUser, eq(reporterUser.id, bookReports.reporterId))
    .leftJoin(resolverUser, eq(resolverUser.id, bookReports.resolvedById));
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const serializeBookReport = (r: BookReportRow) => ({
  id: r.id,
  region: r.region_code,
  book: {
    id: r.book_id,
    title: r.book_title ?? '',
    authors: r.book_authors ?? '',
    publisher: r.book_publisher ?? '',
    published_date: r.book_published_date ?? '',
    cover_url: r.book_cover_url ?? '',
    isbn13: r.book_isbn13 ?? '',
    source: r.book_source ?? '',
  },
  reporter: {
    id: r.reporter_id,
    email: r.reporter_email ?? '',
  },
  fields: parseJsonArray(r.fields),
  detail: r.detail,
  suggested: parseJsonObject(r.suggested),
  status: r.status,
  admin_note: r.admin_note,
  resolved_by: r.resolved_by_id ? { id: r.resolved_by_id, email: r.resolved_by_email ?? '' } : null,
  resolved_at: r.resolved_at,
  created_at: r.created_at,
});

/** What the reporter sees of their own report: no staff identity, no email. */
const serializeOwnBookReport = (r: BookReportRow) => {
  const { reporter: _reporter, resolved_by: _resolvedBy, ...own } = serializeBookReport(r);
  return own;
};

async function bookReportPage(c: Context<AppEnv>, where: SQL | undefined, own = false) {
  const page = pagination(c.req.url);
  const db = createDb(c.env.DB);
  const [[countRow], rows] = await Promise.all([
    db.select({ n: count() }).from(bookReports).where(where),
    selectBookReports(db).where(where).orderBy(desc(bookReports.createdAt), asc(bookReports.id)).limit(page.limit).offset(page.offset),
  ]);
  return c.json(page.wrap(rows.map(own ? serializeOwnBookReport : serializeBookReport), countRow?.n ?? 0));
}

const bookReportCreateSchema = z
  .object({
    book: z.string().regex(UUID_LOOSE_RE, 'common.errValidation'),
    fields: z
      .array(z.enum(BOOK_REPORT_FIELDS, { message: 'common.errValidation' }))
      .min(1, 'common.errValidation')
      .max(7, 'common.errValidation'),
    detail: z.string().max(LIMITS.bookReportDetail, 'common.errValidation').optional().default(''),
    suggested: z
      .object({
        title: z.string().max(LIMITS.bookTitle, 'common.errValidation').optional(),
        authors: z.string().max(LIMITS.bookAuthors, 'common.errValidation').optional(),
        publisher: z.string().max(LIMITS.bookPublisher, 'common.errValidation').optional(),
        published_date: z.string().max(LIMITS.bookPublishedDate, 'common.errValidation').optional(),
        cover: z.string().max(1024, 'common.errValidation').optional(),
        isbn: z.string().max(17, 'common.errValidation').optional(),
        other: z.string().max(255, 'common.errValidation').optional(),
      })
      .optional(),
  })
  .refine((data) => !data.fields.includes('other') || data.detail.trim().length > 0, {
    message: 'bookReport.detailRequired',
    path: ['detail'],
  });

moderationRoutes.post('/book-reports', async (c) => {
  const user = c.get('user')!;
  await checkRate(c, 'report', '20/hour');
  const body = await readJson(c.req);
  const bookId = typeof body.book === 'string' ? body.book : '';
  if (!bookId || !UUID_LOOSE_RE.test(bookId)) notFound();

  const db = createDb(c.env.DB);
  const [book] = await db
    .select({ id: books.id, regionCode: books.regionCode, title: books.title })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!book) notFound();

  const region = await requireRegion(c);
  const verifyIn = book.regionCode ?? region.code;
  await assertMayTrade(c, verifyIn);

  const [pending] = await db
    .select({ id: bookReports.id })
    .from(bookReports)
    .where(and(eq(bookReports.reporterId, user.id), eq(bookReports.bookId, book.id), eq(bookReports.status, 'open')))
    .limit(1);
  if (pending) apiError(400, 'moderation.errAlreadyReported');

  const data = validate(bookReportCreateSchema, body);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db
      .insert(bookReports)
      .values({
        id,
        bookId: book.id,
        regionCode: book.regionCode,
        reporterId: user.id,
        fields: JSON.stringify(data.fields),
        detail: data.detail,
        suggested: data.suggested && Object.keys(data.suggested).length ? JSON.stringify(data.suggested) : null,
        status: 'open',
        adminNote: '',
        resolvedById: null,
        resolvedAt: null,
        createdAt: now,
      })
      .run();
  } catch (e) {
    // Two submissions at once: the partial unique index kept one.
    if (isUniqueViolation(e)) apiError(400, 'moderation.errAlreadyReported');
    throw e;
  }

  const [created] = await selectBookReports(db).where(eq(bookReports.id, id)).limit(1);
  return c.json(serializeOwnBookReport(created!), 201);
});

moderationRoutes.get('/book-reports/mine', async (c) => {
  const region = await requireRegion(c);
  return bookReportPage(c, and(eq(bookReports.reporterId, c.get('user')!.id), eq(bookReports.regionCode, region.code)), true);
});

moderationRoutes.get('/book-reports/all', requireStaff(), async (c) => {
  const where = [scopeWhere(bookReports.regionCode, await managedRegionCodes(c.env, c.get('user')!))];
  const status = optionalStatus(c);
  if (status) where.push(eq(bookReports.status, status as BookReport['status']));
  const region = optionalRegion(c);
  if (region) where.push(eq(bookReports.regionCode, region));
  const field = (c.req.query('field') ?? '').trim();
  if (field && (BOOK_REPORT_FIELDS as readonly string[]).includes(field)) {
    where.push(sql`EXISTS (SELECT 1 FROM json_each(${bookReports.fields}) WHERE value = ${field})`);
  }
  return bookReportPage(c, and(...where));
});

async function scopedBookReport(c: Context<AppEnv>, id: string): Promise<BookReportRow> {
  if (!UUID_LOOSE_RE.test(id)) notFound();
  const scope = scopeWhere(bookReports.regionCode, await managedRegionCodes(c.env, c.get('user')!));
  const [row] = await selectBookReports(createDb(c.env.DB))
    .where(and(eq(bookReports.id, id), scope))
    .limit(1);
  if (!row) notFound();
  return row;
}

moderationRoutes.get('/book-reports/:id', requireStaff(), async (c) => {
  return c.json(serializeBookReport(await scopedBookReport(c, c.req.param('id'))));
});

moderationRoutes.patch('/book-reports/:id', requireStaff(), async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const report = await scopedBookReport(c, id);
  const body = await readJson(c.req);
  const status = nextBookReportStatus(body, report.status);
  const adminNote = typeof body.admin_note === 'string' ? body.admin_note.trim().slice(0, LIMITS.adminNote) : '';

  const db = createDb(c.env.DB);
  const now = new Date().toISOString();
  const res = await db
    .update(bookReports)
    .set({
      status,
      adminNote,
      resolvedById: user.id,
      resolvedAt: now,
    })
    .where(and(eq(bookReports.id, id), eq(bookReports.status, 'open')))
    .run();
  if (!res.meta.changes) fieldErrors({ status: ['admin.errReportAlreadyResolved'] });

  await audit(c, db, 'admin.book_report_resolved', 'book_report', id, {
    book_report_id: id,
    action: status,
    book_id: report.book_id,
    admin_note: adminNote,
  }).run();

  const [fresh] = await selectBookReports(db).where(eq(bookReports.id, id)).limit(1);
  return c.json(serializeBookReport(fresh!));
});
