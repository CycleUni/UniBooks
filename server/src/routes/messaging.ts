import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { authMiddleware } from '../middleware/auth';
import { checkRate } from '../middleware/rateLimit';
import { apiError, notFound, pagination, readJson } from '../lib/http';
import { requireRegion, isVerifiedIn } from '../lib/region';
import { mintChatToken, mintHubToken } from '../services/chatTokens';
import {
  getConversation,
  isParticipant,
  listingDeleted,
  markDeletedBy,
  serializeConversations,
  type ConversationRow,
} from '../services/messaging/conversations';
import { chatImagePrefix } from '../services/messaging/images';
import { UPLOAD_RATE, issueUpload, storeUpload } from '../lib/upload';
import { UUID_LOOSE_RE } from '../lib/uuid';

/**
 * /api/v1/messaging/
 *
 * The ChatRoom Durable Object writes the inbox preview to D1 itself
 * (services/messaging/conversations.recordLatestMessage) and the offline
 * email/push decision runs in UserHub.
 */
/** Everything here needs a signed-in user; the upload PUT below does not. */
const authed = new Hono<AppEnv>();

const MESSAGING_BASE = '/api/v1/messaging/';

authed.use('*', authMiddleware());

// ─── Conversations ────────────────────────────────────────────────────────

authed.get('/conversations', async (c) => {
  const user = c.get('user')!;
  const region = await requireRegion(c);
  const page = pagination(c.req.url);

  // Hidden for the viewer once they deleted it; and a seller is not shown a
  // conversation the buyer opened and never wrote in.
  const where = `region_code = ?1 AND (
      (buyer_id = ?2 AND buyer_deleted_at IS NULL)
      OR (seller_id = ?2 AND seller_deleted_at IS NULL AND latest_message_body IS NOT NULL AND latest_message_body <> '')
    )`;
  const [countRow, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE ${where}`).bind(region.code, user.id).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT * FROM conversations WHERE ${where} ORDER BY updated_at DESC, id LIMIT ?3 OFFSET ?4`)
      .bind(region.code, user.id, page.limit, page.offset)
      .all<ConversationRow>(),
  ]);
  const count = countRow?.n ?? 0;
  const results = await serializeConversations(c.env, rows.results, user.id, region.code);
  return c.json(page.wrap(results, count));
});

authed.post('/conversations', async (c) => {
  const user = c.get('user')!;
  const body = await readJson(c.req);
  const listingId = typeof body.listing_id === 'string' || typeof body.listing_id === 'number' ? String(body.listing_id) : '';

  // Must be verified in the target region: the listing's, wherever it is.
  const target =
    listingId && UUID_LOOSE_RE.test(listingId)
      ? await c.env.DB.prepare('SELECT region_code FROM listings WHERE id = ?').bind(listingId).first<{ region_code: string }>()
      : null;
  const region = await requireRegion(c);
  const verifyIn = target?.region_code ?? region.code;
  if (!(await isVerifiedIn(c.env, user.id, verifyIn))) {
    apiError(403, 'acct.errUnverifiedInRegion', { region: verifyIn });
  }

  if (!listingId) apiError(400, 'msg.errListingRequired');
  if (!UUID_LOOSE_RE.test(listingId)) apiError(404, 'msg.errListingNotFound');

  const listing = await c.env.DB.prepare(
    `SELECT l.id, l.seller_id, l.status, l.region_code, b.title AS book_title, b.isbn13 AS book_isbn
       FROM listings l LEFT JOIN books b ON b.id = l.book_id
      WHERE l.id = ? AND l.region_code = ?`,
  )
    .bind(listingId, region.code)
    .first<{ id: string; seller_id: string; status: string; region_code: string; book_title: string | null; book_isbn: string | null }>();
  if (!listing) apiError(404, 'msg.errListingNotFound');
  if (listing.seller_id === user.id) apiError(400, 'msg.errCannotMessageSelf');

  const findExisting = () =>
    c.env.DB.prepare('SELECT * FROM conversations WHERE listing_id = ? AND buyer_id = ?')
      .bind(listing.id, user.id)
      .first<ConversationRow>();

  let conv = await findExisting();
  let created = false;
  if (!conv) {
    // A new conversation starts with its first message; once the listing is
    // taken down or sold there is nothing left to ask about.
    if (listing.status === 'removed' || listing.status === 'sold') apiError(409, 'msg.errListingUnavailable');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const res = await c.env.DB.prepare(
      `INSERT INTO conversations (id, room_id, region_code, buyer_id, seller_id, listing_id, listing_ref,
                                  book_title, book_isbn, latest_message_body, last_message_at, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
      .bind(
        id,
        id,
        listing.region_code,
        user.id,
        listing.seller_id,
        listing.id,
        listing.id,
        (listing.book_title ?? '').slice(0, 255),
        listing.book_isbn ?? '',
        now,
        now,
      )
      .run();
    created = (res.meta.changes ?? 0) > 0;
    conv = await findExisting();
    if (!conv) apiError(409, 'msg.errListingUnavailable');
  }
  const [data] = await serializeConversations(c.env, [conv], user.id, region.code);
  return c.json(data, created ? 201 : 200);
});

authed.delete('/conversations/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  if (!UUID_LOOSE_RE.test(id)) return notFound(c);
  const region = await requireRegion(c);
  const conv = await getConversation(c.env, id);
  if (!conv || conv.region_code !== region.code) return notFound(c);
  const result = await markDeletedBy(c.env, conv, user.id);
  if (result === false) apiError(403, 'msg.errNotParticipant');
  return c.json({ status: result });
});

/**
 * The app's MessageService declares this (markConversationRead); read state
 * lives in the user's UserHub, so this is the same mark-read the chat
 * transport's /api/chat/rooms/<room>/read does, reached with the access token.
 */
authed.post('/conversations/:id/read', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  if (!UUID_LOOSE_RE.test(id)) return notFound(c);
  const conv = await getConversation(c.env, id);
  if (!conv) return notFound(c);
  if (!isParticipant(conv, user.id)) apiError(403, 'msg.errNotParticipant');
  const hub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(user.id));
  await hub.fetch('https://internal/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_id: conv.id }),
  });
  return c.body(null, 204);
});

// ─── Chat tokens ──────────────────────────────────────────────────────────

authed.get('/chat-token', async (c) => {
  const user = c.get('user')!;
  const conversationId = c.req.query('conversation_id');
  if (!conversationId) apiError(400, 'msg.errConversationRequired');
  if (!UUID_LOOSE_RE.test(conversationId)) return notFound(c);
  const conv = await getConversation(c.env, conversationId);
  if (!conv) return notFound(c);
  if (!isParticipant(conv, user.id)) apiError(403, 'msg.errNotParticipant');

  // The seller deleted the listing: both sides may still read the history,
  // but there is nothing left to arrange, so the room refuses their sends.
  const token = await mintChatToken(c.env, {
    userId: user.id,
    roomId: conv.id,
    participantIds: [conv.buyer_id, conv.seller_id],
    role: listingDeleted(conv) ? 'observer' : 'user',
  });
  return c.json({ token });
});

authed.get('/hub-token', async (c) => {
  const user = c.get('user')!;
  const token = await mintHubToken(c.env, user.id);
  return c.json({ token });
});

// ─── Chat image uploads ───────────────────────────────────────────────────

/** The conversation an upload is for, if the caller may post images into it. */
async function uploadableConversation(c: Context<AppEnv>, raw: unknown): Promise<ConversationRow> {
  const user = c.get('user')!;
  const conversationId = typeof raw === 'string' ? raw : '';
  if (!conversationId) apiError(400, 'msg.errConversationRequired');
  const conv = UUID_LOOSE_RE.test(conversationId) ? await getConversation(c.env, conversationId) : null;
  if (!conv) apiError(404, 'msg.errConversationNotFound');
  if (!isParticipant(conv, user.id)) apiError(403, 'msg.errNotParticipant');
  // A deleted listing's chat stays readable but takes no new messages.
  if (listingDeleted(conv)) apiError(403, 'msg.errListingDeleted');
  return conv;
}

/** Step one (lib/upload.ts): only a participant may post an image into a chat. */
authed.post('/uploads', async (c) => {
  const user = c.get('user')!;
  await checkRate(c, 'upload', UPLOAD_RATE);
  const body = await readJson(c.req);
  await uploadableConversation(c, body.conversation_id);
  return issueUpload(c, { action: 'chat_image', userId: user.id, keyPrefix: chatImagePrefix(user.id), base: MESSAGING_BASE }, body);
});

/**
 * The upload PUT is mounted first, outside `authed`: the upload token is its
 * credential (the app's PUT to an absolute URL may carry no access token),
 * and its handler answers before the auth middleware would run.
 */
export const messagingRoutes = new Hono<AppEnv>();
messagingRoutes.put('/uploads/file', (c) => storeUpload(c, { action: 'chat_image', keyPrefix: chatImagePrefix }));
messagingRoutes.route('/', authed);
