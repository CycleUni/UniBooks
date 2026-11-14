import { and, eq, inArray, isNotNull, notExists, or, sql, type SQL } from 'drizzle-orm';
import type { Env } from '../../env';
import { chatReports, conversations, conversationListings, createDb, type Database } from '../../db';
import { chatRoomStub, postSystemMessage } from '../../lib/chat';
import { storageKeyFromUrl } from '../../lib/media';
import { siteOrigin } from '../../lib/origin';
import { chatImagePrefix } from './images';
import { loadPeople, schoolInfosIn } from './people';
import { parsePhotos } from '../../lib/json';
import { coverUrlFor } from '../catalog/covers';

/**
 * Inbox-preview placeholder for an image message. An i18n key rather than
 * text: the preview is stored once and shown to both participants, who may
 * read in different languages; the app resolves it per viewer.
 */
export const IMAGE_PREVIEW_TOKEN = '[SYSTEM:msg.imagePlaceholder]';

export interface ConversationRow {
  id: string;
  room_id: string;
  region_code: string;
  buyer_id: string;
  seller_id: string;
  listing_id: string | null;
  listing_ref: string | null;
  book_title: string;
  book_isbn: string;
  latest_message_body: string | null;
  last_message_at: string | null;
  updated_at: string;
  created_at: string;
  buyer_deleted_at: string | null;
  seller_deleted_at: string | null;
}

/** Every conversations column, under its SQL name (the shape ConversationRow describes). */
export function selectConversations(db: Database) {
  return db
    .select({
      id: conversations.id,
      room_id: conversations.roomId,
      region_code: conversations.regionCode,
      buyer_id: conversations.buyerId,
      seller_id: conversations.sellerId,
      listing_id: conversations.listingId,
      listing_ref: conversations.listingRef,
      book_title: conversations.bookTitle,
      book_isbn: conversations.bookIsbn,
      latest_message_body: conversations.latestMessageBody,
      last_message_at: conversations.lastMessageAt,
      updated_at: conversations.updatedAt,
      created_at: conversations.createdAt,
      buyer_deleted_at: conversations.buyerDeletedAt,
      seller_deleted_at: conversations.sellerDeletedAt,
    })
    .from(conversations);
}

export async function getConversation(env: Env, id: string): Promise<ConversationRow | null> {
  const [row] = await selectConversations(createDb(env.DB)).where(eq(conversations.id, id)).limit(1);
  return row ?? null;
}

export const isParticipant = (conv: Pick<ConversationRow, 'buyer_id' | 'seller_id'>, userId: string) =>
  conv.buyer_id === userId || conv.seller_id === userId;

/** Whether the conversation's listing has been deleted. */
export const listingDeleted = (conv: Pick<ConversationRow, 'listing_id'>) => conv.listing_id === null;

export async function isConversationReadOnly(env: Env, conv: ConversationRow): Promise<boolean> {
  if (conv.listing_id !== null) return false;
  const db = createDb(env.DB);
  const [activeListing] = await db
    .select({ one: sql`1` })
    .from(conversationListings)
    .where(and(eq(conversationListings.conversationId, conv.id), isNotNull(conversationListings.listingId)))
    .limit(1);
  return !activeListing;
}

export async function attachListingToConversation(
  env: Env,
  conv: ConversationRow,
  listing: { id: string; bookTitle?: string | null; bookIsbn?: string | null },
  userId: string,
): Promise<boolean> {
  const db = createDb(env.DB);
  const now = new Date().toISOString();
  const title = (listing.bookTitle ?? '').slice(0, 255);
  const isbn = listing.bookIsbn ?? '';

  const res = await db
    .insert(conversationListings)
    .values({
      conversationId: conv.id,
      listingId: listing.id,
      listingRef: listing.id,
      bookTitle: title,
      bookIsbn: isbn,
      addedAt: now,
      addedById: userId,
    })
    .onConflictDoNothing()
    .run();

  const newlyAdded = (res.meta.changes ?? 0) > 0;
  if (newlyAdded) {
    await postSystemMessage(env, {
      roomId: conv.id,
      participantIds: [conv.buyer_id, conv.seller_id],
      senderId: userId,
      content: `[SYSTEM:msg.buyerInquiredBook] ${title}`,
    });
  }
  return newlyAdded;
}

export interface SerializedConversationListing {
  ref: string;
  id: string | null;
  title: string;
  isbn: string;
  price: number | null;
  status: string | null;
  cover_url: string;
  is_available: boolean;
}

interface ConversationListingJoinRow {
  conversation_id: string;
  listing_id: string | null;
  listing_ref: string;
  book_title: string;
  book_isbn: string;
  added_at: string;
  added_by_id: string;
  l_status: string | null;
  l_price: number | null;
  l_photos: string | null;
  b_cover: string | null;
  b_cover_r2_key: string | null;
}

export async function fetchListingsForConversations(
  env: Env,
  conversationIds: string[],
): Promise<Map<string, SerializedConversationListing[]>> {
  const ids = [...new Set(conversationIds.filter(Boolean))];
  const map = new Map<string, SerializedConversationListing[]>();
  if (!ids.length) return map;

  const rows = await env.DB.prepare(
    `SELECT cl.*, l.status AS l_status, l.price AS l_price, l.photos AS l_photos, b.cover_url AS b_cover, b.cover_r2_key AS b_cover_r2_key
     FROM conversation_listings cl
     LEFT JOIN listings l ON l.id = cl.listing_id
     LEFT JOIN books b ON b.id = l.book_id
     WHERE cl.conversation_id IN (SELECT value FROM json_each(?))
     ORDER BY cl.added_at ASC`,
  )
    .bind(JSON.stringify(ids))
    .all<ConversationListingJoinRow>()
    .then((r) => r.results);

  for (const row of rows) {
    const photos = parsePhotos(row.l_photos);
    const cover =
      photos[0] ??
      coverUrlFor(env, undefined, {
        cover_url: typeof row.b_cover === 'string' ? row.b_cover : null,
        cover_r2_key: typeof row.b_cover_r2_key === 'string' ? row.b_cover_r2_key : null,
      });
    const item: SerializedConversationListing = {
      ref: row.listing_ref,
      id: row.listing_id,
      title: row.book_title,
      isbn: row.book_isbn,
      price: typeof row.l_price === 'number' ? row.l_price : null,
      status: typeof row.l_status === 'string' ? row.l_status : null,
      cover_url: cover,
      is_available: row.l_status === 'active',
    };
    const list = map.get(row.conversation_id);
    if (list) list.push(item);
    else map.set(row.conversation_id, [item]);
  }

  return map;
}

/**
 * Mirror a new message into the conversation row: the inbox preview and its
 * sort key. The ChatRoom
 * Durable Object calls this directly. An image is previewed as
 * IMAGE_PREVIEW_TOKEN, never as its URL.
 */
export async function recordLatestMessage(
  env: Env,
  roomId: string,
  content: string,
  messageType: string,
  at: Date = new Date(),
): Promise<void> {
  const body = messageType === 'image' ? IMAGE_PREVIEW_TOKEN : content;
  const iso = at.toISOString();
  await createDb(env.DB)
    .update(conversations)
    .set({ latestMessageBody: body, lastMessageAt: iso, updatedAt: iso })
    .where(eq(conversations.id, roomId))
    .run();
}

/**
 * Hide the conversation for `userId`, and remove it once nobody needs it (see
 * removeConversations). Only the caller's own column is written — updated_at
 * is left alone, so the other side's inbox order does not move.
 */
export async function markDeletedBy(env: Env, conv: ConversationRow, userId: string): Promise<'hidden' | 'deleted' | false> {
  let column: 'buyerDeletedAt' | 'sellerDeletedAt';
  if (conv.buyer_id === userId) column = 'buyerDeletedAt';
  else if (conv.seller_id === userId) column = 'sellerDeletedAt';
  else return false;
  const now = new Date().toISOString();
  await createDb(env.DB)
    .update(conversations)
    .set({ [column]: sql`COALESCE(${conversations[column]}, ${now})` })
    .where(eq(conversations.id, conv.id))
    .run();
  const removed = await removeConversations(env, eq(conversations.id, conv.id));
  return removed > 0 ? 'deleted' : 'hidden';
}

/**
 * Marks every conversation of an account being deleted as deleted on its
 * side, then removes those the other side had already deleted. The other
 * side keeps the rest, read-only, until they delete it too.
 */
export async function markAllDeletedFor(env: Env, userId: string): Promise<number> {
  const db = createDb(env.DB);
  const now = new Date().toISOString();
  await db.batch([
    db
      .update(conversations)
      .set({ buyerDeletedAt: now })
      .where(and(eq(conversations.buyerId, userId), sql`${conversations.buyerDeletedAt} IS NULL`)),
    db
      .update(conversations)
      .set({ sellerDeletedAt: now })
      .where(and(eq(conversations.sellerId, userId), sql`${conversations.sellerDeletedAt} IS NULL`)),
  ]);
  return removeConversations(env, or(eq(conversations.buyerId, userId), eq(conversations.sellerId, userId))!);
}

/**
 * The daily catch-up (jobs runCleanup): marks the side of an account deleted
 * before markAllDeletedFor existed, and removes conversations that became
 * removable since — a report resolved, say. Bounded per run.
 */
export async function sweepDeletedConversations(env: Env): Promise<number> {
  const db = createDb(env.DB);
  const now = new Date().toISOString();
  await db.batch([
    db
      .update(conversations)
      .set({ buyerDeletedAt: now })
      .where(
        sql`${conversations.buyerDeletedAt} IS NULL AND ${conversations.buyerId} IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)`,
      ),
    db
      .update(conversations)
      .set({ sellerDeletedAt: now })
      .where(
        sql`${conversations.sellerDeletedAt} IS NULL AND ${conversations.sellerId} IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)`,
      ),
  ]);
  return removeConversations(env, sql`1 = 1`, 200);
}

/**
 * A conversation nobody needs: both sides deleted it (an account deletion
 * marks its side, see markAllDeletedFor), and no report on it is still open —
 * a report names messages by id, so staff need the room until they decide.
 */
function removable(db: Database): SQL {
  return and(
    isNotNull(conversations.buyerDeletedAt),
    isNotNull(conversations.sellerDeletedAt),
    notExists(
      db
        .select({ one: sql`1` })
        .from(chatReports)
        .where(and(eq(chatReports.conversationId, conversations.id), eq(chatReports.status, 'open'))),
    ),
  )!;
}

/**
 * Removes the conversations matching `where` that nobody needs: the D1 row
 * with its chat reports, then each room's messages (ChatRoom storage) and the
 * images sent in it. Returns how many rows went. `limit` bounds a sweep.
 */
export async function removeConversations(env: Env, where: SQL, limit = 500): Promise<number> {
  const db = createDb(env.DB);
  const due = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(where, removable(db)))
    .limit(limit);
  if (!due.length) return 0;
  const ids = due.map((r) => r.id);
  // Checked again in the delete itself: a report filed or a mark undone in
  // between keeps the row. Whichever request removes a row purges its room.
  const [, , gone] = await db.batch([
    db.delete(chatReports).where(
      and(
        inArray(chatReports.conversationId, ids),
        sql`EXISTS (SELECT 1 FROM conversations c WHERE c.id = ${chatReports.conversationId}
          AND c.buyer_deleted_at IS NOT NULL AND c.seller_deleted_at IS NOT NULL)`,
        sql`NOT EXISTS (SELECT 1 FROM chat_reports o WHERE o.conversation_id = ${chatReports.conversationId} AND o.status = 'open')`,
      ),
    ),
    db.delete(conversationListings).where(inArray(conversationListings.conversationId, ids)),
    db
      .delete(conversations)
      .where(and(inArray(conversations.id, ids), removable(db)))
      .returning({ roomId: conversations.roomId }),
  ]);
  for (const { roomId } of gone) await purgeRoom(env, roomId);
  return gone.length;
}

/**
 * Drops a removed conversation's messages and the images sent in it. Best
 * effort: the row is already gone, and nobody can reach the room without it.
 */
async function purgeRoom(env: Env, roomId: string): Promise<void> {
  try {
    const { images } = await chatRoomStub(env, roomId).purge();
    const origin = siteOrigin(env);
    for (const { userId, url } of images) {
      const res = storageKeyFromUrl(env, origin, url);
      // Only a chat upload in its sender's folder; anything else is not ours to delete.
      if ('error' in res || !res.key.startsWith(chatImagePrefix(userId))) continue;
      await env.R2.delete(res.key);
    }
  } catch (e) {
    console.error('[messaging] room purge failed', roomId, e);
  }
}

interface OrderRow {
  id: string;
  listing_ref: string | null;
  buyer_id: string;
  status: string;
  meetup_time: string | null;
  meetup_location: string | null;
  created_at: string;
}

/**
 * Conversations as `viewerId` sees them. Batched: one query per
 * related table for the whole page, never per row.
 */
export async function serializeConversations(
  env: Env,
  rows: ConversationRow[],
  viewerId: string,
  regionCode: string,
): Promise<Record<string, unknown>[]> {
  if (!rows.length) return [];

  const otherIds = rows.map((r) => (r.buyer_id === viewerId ? r.seller_id : r.buyer_id));
  const listingIds = [...new Set(rows.map((r) => r.listing_id).filter((x): x is string => !!x))];
  const refs = [...new Set(rows.map((r) => r.listing_ref).filter((x): x is string => !!x))];
  const convIds = rows.map((r) => r.id);

  const [people, schools, listingRows, listingsMap] = await Promise.all([
    loadPeople(env, otherIds),
    schoolInfosIn(env, otherIds, regionCode),
    // Raw: `IN json_each(...)` over the page's ids, and listings as `l.*` rows.
    listingIds.length
      ? env.DB.prepare(
          `SELECT l.*, b.cover_url AS _cover, b.cover_r2_key AS _cover_r2_key FROM listings l LEFT JOIN books b ON b.id = l.book_id
            WHERE l.id IN (SELECT value FROM json_each(?))`,
        )
          .bind(JSON.stringify(listingIds))
          .all<Record<string, unknown>>()
          .then((r) => r.results)
      : Promise.resolve([] as Record<string, unknown>[]),
    fetchListingsForConversations(env, convIds),
  ]);

  const allRefs = [...new Set([...refs, ...Array.from(listingsMap.values()).flatMap((items) => items.map((i) => i.ref))])];

  const orderRows = allRefs.length
    ? await env.DB.prepare(
        `SELECT id, listing_ref, buyer_id, status, meetup_time, meetup_location, created_at FROM orders
          WHERE listing_ref IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC`,
      )
        .bind(JSON.stringify(allRefs))
        .all<OrderRow>()
        .then((r) => r.results)
    : [];

  const listings = new Map(listingRows.map((l) => [String(l.id), l]));

  return rows.map((conv) => {
    const iAmBuyer = conv.buyer_id === viewerId;
    const otherId = iAmBuyer ? conv.seller_id : conv.buyer_id;
    const other = people.get(otherId);
    const listing = conv.listing_id ? listings.get(conv.listing_id) : undefined;

    let convListings = listingsMap.get(conv.id);
    if (!convListings || !convListings.length) {
      let photo = '';
      if (listing) {
        const photos = parsePhotos(listing.photos);
        photo =
          photos[0] ??
          coverUrlFor(env, undefined, {
            cover_url: typeof listing._cover === 'string' ? listing._cover : null,
            cover_r2_key: typeof listing._cover_r2_key === 'string' ? listing._cover_r2_key : null,
          });
      }
      convListings = [
        {
          ref: conv.listing_ref || conv.listing_id || '',
          id: conv.listing_id,
          title: conv.book_title,
          isbn: conv.book_isbn,
          price: listing ? (listing.price as number) : null,
          status: listing ? (listing.status as string) : null,
          cover_url: photo,
          is_available: listing ? listing.status === 'active' : false,
        },
      ];
    }

    const convRefs = new Set(convListings.map((l) => l.ref));
    if (conv.listing_ref) convRefs.add(conv.listing_ref);

    // The most recent order between this buyer and any listing of this conversation, preferring
    // one that is not cancelled.
    const mine = orderRows.filter((o) => o.listing_ref && convRefs.has(o.listing_ref) && o.buyer_id === conv.buyer_id);
    const order = mine.find((o) => o.status !== 'cancelled') ?? mine[0] ?? null;

    let photo = '';
    if (listing) {
      const photos = parsePhotos(listing.photos);
      photo =
        photos[0] ??
        coverUrlFor(env, undefined, {
          cover_url: typeof listing._cover === 'string' ? listing._cover : null,
          cover_r2_key: typeof listing._cover_r2_key === 'string' ? listing._cover_r2_key : null,
        });
    } else if (convListings[0]?.cover_url) {
      photo = convListings[0].cover_url;
    }

    const isAllDeleted = convListings.every((l) => l.id === null);

    return {
      id: conv.id,
      listing_id: conv.listing_ref ?? convListings[0]?.ref ?? null,
      listing_title: conv.book_title || convListings[0]?.title || '',
      listing_isbn: conv.book_isbn || convListings[0]?.isbn || '',
      listing_deleted: isAllDeleted,
      listing_photo: photo,
      listing_price: listing ? (listing.price as number) : (convListings[0]?.price ?? null),
      listing_condition: listing ? (listing.condition as string) : null,
      listing_course: listing ? ((listing.course_name as string | undefined) ?? '') : null,
      listings: convListings,
      other_party: other?.displayName ?? '',
      other_party_role: iAmBuyer ? 'seller' : 'buyer',
      other_party_school_name: schools.get(otherId)?.schoolName ?? '',
      other_party_is_verified: schools.get(otherId)?.isVerified ?? false,
      other_party_avatar_url: other?.publicAvatarUrl ?? '',
      buyer_id: conv.buyer_id,
      seller_id: conv.seller_id,
      latest_message: conv.latest_message_body || '',
      updated_at: conv.updated_at,
      order_id: order?.id ?? null,
      order_status: order?.status ?? null,
      order_meetup_time: order?.meetup_time ?? null,
      order_meetup_location: order ? (order.meetup_location ?? '') : '',
    };
  });
}
