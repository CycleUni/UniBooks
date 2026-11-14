import { Hono, type Context } from 'hono';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { books, conversations, conversationListings, createDb, listings, orders } from '../db';
import { authMiddleware } from '../middleware/auth';
import { checkRate } from '../middleware/rateLimit';
import { apiError, notFound, pagination, readJson } from '../lib/http';
import { requireRegion, assertMayTrade } from '../lib/region';
import { mintChatToken } from '../services/chatTokens';
import {
  attachListingToConversation,
  getConversation,
  isConversationReadOnly,
  isParticipant,
  markDeletedBy,
  selectConversations,
  serializeConversations,
  type ConversationRow,
} from '../services/messaging/conversations';
import { parsePhotos } from '../lib/json';
import { coverUrlFor } from '../services/catalog/covers';
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

/** New conversations one user may start. */
export const CONVERSATION_CREATE_RATE = '30/hour';

authed.use('*', authMiddleware());

// ─── Conversations ────────────────────────────────────────────────────────

authed.get('/conversations', async (c) => {
  const user = c.get('user')!;
  const region = await requireRegion(c);
  const page = pagination(c.req.url);

  // Hidden for the viewer once they deleted it; and a seller is not shown a
  // conversation the buyer opened and never wrote in.
  const where = and(
    eq(conversations.regionCode, region.code),
    or(
      and(eq(conversations.buyerId, user.id), isNull(conversations.buyerDeletedAt)),
      and(
        eq(conversations.sellerId, user.id),
        isNull(conversations.sellerDeletedAt),
        isNotNull(conversations.latestMessageBody),
        ne(conversations.latestMessageBody, ''),
      ),
    ),
  );
  const db = createDb(c.env.DB);
  const [[countRow], rows] = await Promise.all([
    db.select({ n: count() }).from(conversations).where(where),
    selectConversations(db)
      .where(where)
      .orderBy(desc(conversations.updatedAt), asc(conversations.id))
      .limit(page.limit)
      .offset(page.offset),
  ]);
  const results = await serializeConversations(c.env, rows, user.id, region.code);
  return c.json(page.wrap(results, countRow?.n ?? 0));
});

authed.post('/conversations', async (c) => {
  const user = c.get('user')!;
  const body = await readJson(c.req);
  const listingId = typeof body.listing_id === 'string' || typeof body.listing_id === 'number' ? String(body.listing_id) : '';
  const db = createDb(c.env.DB);

  // Must be verified in the target region: the listing's, wherever it is.
  const [target] =
    listingId && UUID_LOOSE_RE.test(listingId)
      ? await db.select({ regionCode: listings.regionCode }).from(listings).where(eq(listings.id, listingId)).limit(1)
      : [];
  const region = await requireRegion(c);
  const verifyIn = target?.regionCode ?? region.code;
  await assertMayTrade(c, verifyIn);

  if (!listingId) apiError(400, 'msg.errListingRequired');
  if (!UUID_LOOSE_RE.test(listingId)) apiError(404, 'msg.errListingNotFound');

  const [listing] = await db
    .select({
      id: listings.id,
      sellerId: listings.sellerId,
      status: listings.status,
      regionCode: listings.regionCode,
      bookTitle: books.title,
      bookIsbn: books.isbn13,
    })
    .from(listings)
    .leftJoin(books, eq(books.id, listings.bookId))
    .where(and(eq(listings.id, listingId), eq(listings.regionCode, region.code)))
    .limit(1);
  if (!listing) apiError(404, 'msg.errListingNotFound');
  if (listing.sellerId === user.id) apiError(400, 'msg.errCannotMessageSelf');

  // A chat that already covers this listing is simply reopened, whatever the
  // listing's state now and whether or not the buyer had hidden it: that is
  // how a buyer gets back to the seller of a book they bought.
  const [about] = await selectConversations(db)
    .where(
      and(
        eq(conversations.buyerId, user.id),
        or(
          eq(conversations.listingId, listing.id),
          inArray(
            conversations.id,
            db
              .select({ id: conversationListings.conversationId })
              .from(conversationListings)
              .where(eq(conversationListings.listingId, listing.id)),
          ),
        ),
      ),
    )
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(1);
  if (about) {
    const [data] = await serializeConversations(c.env, [about], user.id, region.code);
    return c.json(data, 200);
  }

  // Bringing a listing into a chat for the first time: once it is taken down
  // or sold there is nothing left to ask about.
  if (listing.status === 'removed' || listing.status === 'sold') apiError(409, 'msg.errListingUnavailable');

  // Otherwise the listing joins the buyer's current chat with this seller.
  const findExisting = async () => {
    const [row] = await selectConversations(db)
      .where(
        and(
          eq(conversations.buyerId, user.id),
          eq(conversations.sellerId, listing.sellerId),
          eq(conversations.regionCode, region.code),
          isNull(conversations.buyerDeletedAt),
        ),
      )
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(1);
    return row ?? null;
  };

  let conv = await findExisting();
  let created = false;
  if (conv) {
    const attached = await attachListingToConversation(c.env, conv, listing, user.id);
    if (attached) {
      conv = (await findExisting()) ?? conv;
    }
  } else {
    // Each new conversation is a fresh inbox entry (and notification) for a
    // seller; reopening an existing one is not counted.
    await checkRate(c, 'conversation_create', CONVERSATION_CREATE_RATE);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const res = await db
      .insert(conversations)
      .values({
        id,
        roomId: id,
        regionCode: listing.regionCode,
        buyerId: user.id,
        sellerId: listing.sellerId,
        listingId: listing.id,
        listingRef: listing.id,
        bookTitle: (listing.bookTitle ?? '').slice(0, 255),
        bookIsbn: listing.bookIsbn ?? '',
        latestMessageBody: null,
        lastMessageAt: null,
        updatedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    created = (res.meta.changes ?? 0) > 0;
    conv = await findExisting();
    if (!conv) apiError(409, 'msg.errListingUnavailable');

    await db
      .insert(conversationListings)
      .values({
        conversationId: conv.id,
        listingId: listing.id,
        listingRef: listing.id,
        bookTitle: (listing.bookTitle ?? '').slice(0, 255),
        bookIsbn: listing.bookIsbn ?? '',
        addedAt: now,
        addedById: user.id,
      })
      .onConflictDoNothing()
      .run();
  }
  const [data] = await serializeConversations(c.env, [conv], user.id, region.code);
  return c.json(data, created ? 201 : 200);
});

authed.get('/conversations/:id/candidate-listings', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  if (!UUID_LOOSE_RE.test(id)) return notFound(c);
  const region = await requireRegion(c);
  const conv = await getConversation(c.env, id);
  if (!conv || conv.region_code !== region.code) return notFound(c);

  // Sellers cannot attach listings; only the buyer does
  if (conv.buyer_id !== user.id) apiError(403, 'msg.errBuyerOnly');

  const page = pagination(c.req.url);
  const db = createDb(c.env.DB);

  const attachedRefs = db
    .select({ ref: conversationListings.listingRef })
    .from(conversationListings)
    .where(eq(conversationListings.conversationId, conv.id));

  const where = and(
    eq(listings.sellerId, conv.seller_id),
    eq(listings.regionCode, conv.region_code),
    eq(listings.status, 'active'),
    notInArray(listings.id, attachedRefs),
  );

  const [[countRow], rows] = await Promise.all([
    db.select({ n: count() }).from(listings).where(where),
    db
      .select({
        id: listings.id,
        price: listings.price,
        condition: listings.condition,
        courseName: listings.courseName,
        photos: listings.photos,
        title: books.title,
        isbn: books.isbn13,
        coverUrl: books.coverUrl,
        coverR2Key: books.coverR2Key,
      })
      .from(listings)
      .leftJoin(books, eq(books.id, listings.bookId))
      .where(where)
      .orderBy(desc(listings.createdAt))
      .limit(page.limit)
      .offset(page.offset),
  ]);

  const results = rows.map((r) => {
    const photos = parsePhotos(r.photos);
    const cover =
      photos[0] ??
      coverUrlFor(c.env, undefined, {
        cover_url: r.coverUrl,
        cover_r2_key: r.coverR2Key,
      });
    return {
      id: r.id,
      title: r.title ?? '',
      isbn: r.isbn ?? '',
      price: r.price,
      condition: r.condition,
      course_name: r.courseName ?? '',
      cover_url: cover,
    };
  });

  return c.json(page.wrap(results, countRow?.n ?? 0));
});

authed.post('/conversations/:id/listings', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  if (!UUID_LOOSE_RE.test(id)) return notFound(c);
  const region = await requireRegion(c);
  let conv = await getConversation(c.env, id);
  if (!conv || conv.region_code !== region.code) return notFound(c);

  if (conv.buyer_id !== user.id) apiError(403, 'msg.errBuyerOnly');

  const body = await readJson(c.req);
  const listingId = typeof body.listing_id === 'string' || typeof body.listing_id === 'number' ? String(body.listing_id) : '';
  if (!listingId) apiError(400, 'msg.errListingRequired');
  if (!UUID_LOOSE_RE.test(listingId)) apiError(404, 'msg.errListingNotFound');

  const db = createDb(c.env.DB);
  const [listing] = await db
    .select({
      id: listings.id,
      sellerId: listings.sellerId,
      status: listings.status,
      regionCode: listings.regionCode,
      bookTitle: books.title,
      bookIsbn: books.isbn13,
    })
    .from(listings)
    .leftJoin(books, eq(books.id, listings.bookId))
    .where(and(eq(listings.id, listingId), eq(listings.regionCode, region.code)))
    .limit(1);

  if (!listing) apiError(404, 'msg.errListingNotFound');
  if (listing.sellerId !== conv.seller_id) apiError(400, 'msg.errListingWrongSeller');
  if (listing.status !== 'active') apiError(409, 'msg.errListingUnavailable');

  const attached = await attachListingToConversation(c.env, conv, listing, user.id);
  if (attached) {
    conv = (await getConversation(c.env, id)) ?? conv;
  }

  const [data] = await serializeConversations(c.env, [conv], user.id, region.code);
  return c.json(data, 200);
});

authed.delete('/conversations/:id/listings/:listingRef', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const listingRef = c.req.param('listingRef');
  if (!UUID_LOOSE_RE.test(id)) return notFound(c);
  const region = await requireRegion(c);
  const conv = await getConversation(c.env, id);
  if (!conv || conv.region_code !== region.code) return notFound(c);

  // Sellers cannot remove listings; only the buyer does
  if (conv.buyer_id !== user.id) apiError(403, 'msg.errBuyerOnly');

  const db = createDb(c.env.DB);

  // Check how many listings: cannot remove the last one
  const [{ total }] = await db
    .select({ total: count() })
    .from(conversationListings)
    .where(eq(conversationListings.conversationId, conv.id));

  if (total <= 1) apiError(400, 'msg.errCannotRemoveLastListing');

  // Check if open order exists: not one with an open order
  const [openOrder] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.buyerId, user.id),
        or(eq(orders.listingRef, listingRef), eq(orders.listingId, listingRef)),
        inArray(orders.status, ['pending', 'accepted', 'handed_over']),
      ),
    )
    .limit(1);

  if (openOrder) apiError(409, 'msg.errListingHasOpenOrder');

  const res = await db
    .delete(conversationListings)
    .where(and(eq(conversationListings.conversationId, conv.id), eq(conversationListings.listingRef, listingRef)))
    .run();

  if ((res.meta.changes ?? 0) === 0) apiError(404, 'msg.errListingNotFound');

  return c.json({ success: true });
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
  const isReadOnly = await isConversationReadOnly(c.env, conv);
  const token = await mintChatToken(c.env, {
    userId: user.id,
    roomId: conv.id,
    participantIds: [conv.buyer_id, conv.seller_id],
    role: isReadOnly ? 'observer' : 'user',
  });
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
  if (await isConversationReadOnly(c.env, conv)) apiError(403, 'msg.errListingDeleted');
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
