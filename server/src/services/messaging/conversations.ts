import type { Env } from '../../env';
import { loadPeople, schoolNamesIn } from './people';
import { parsePhotos } from '../../lib/json';

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

export async function getConversation(env: Env, id: string): Promise<ConversationRow | null> {
  return env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<ConversationRow>();
}

export const isParticipant = (conv: Pick<ConversationRow, 'buyer_id' | 'seller_id'>, userId: string) =>
  conv.buyer_id === userId || conv.seller_id === userId;

/** Whether the conversation's listing has been deleted. */
export const listingDeleted = (conv: Pick<ConversationRow, 'listing_id'>) => conv.listing_id === null;

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
  await env.DB.prepare('UPDATE conversations SET latest_message_body = ?, last_message_at = ?, updated_at = ? WHERE id = ?')
    .bind(body, iso, iso, roomId)
    .run();
}

/**
 * Hide the conversation for `userId`;
 * remove the row (and its chat reports, CASCADE) once both sides have.
 * Only the caller's own column is written — updated_at is left alone, so the
 * other side's inbox order does not move.
 */
export async function markDeletedBy(env: Env, conv: ConversationRow, userId: string): Promise<'hidden' | 'deleted' | false> {
  let column: 'buyer_deleted_at' | 'seller_deleted_at';
  if (conv.buyer_id === userId) column = 'buyer_deleted_at';
  else if (conv.seller_id === userId) column = 'seller_deleted_at';
  else return false;
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE conversations SET ${column} = COALESCE(${column}, ?) WHERE id = ?`).bind(now, conv.id).run();
  // Conditional delete: whichever request sets the second mark removes the row.
  const del = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM chat_reports WHERE conversation_id = ?
         AND EXISTS (SELECT 1 FROM conversations WHERE id = ? AND buyer_deleted_at IS NOT NULL AND seller_deleted_at IS NOT NULL)`,
    ).bind(conv.id, conv.id),
    env.DB.prepare('DELETE FROM conversations WHERE id = ? AND buyer_deleted_at IS NOT NULL AND seller_deleted_at IS NOT NULL').bind(
      conv.id,
    ),
  ]);
  return (del[1].meta.changes ?? 0) > 0 ? 'deleted' : 'hidden';
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

  const [people, schools, listingRows, orderRows] = await Promise.all([
    loadPeople(env, otherIds),
    schoolNamesIn(env, otherIds, regionCode),
    listingIds.length
      ? env.DB.prepare(
          `SELECT l.*, b.cover_url AS _cover FROM listings l LEFT JOIN books b ON b.id = l.book_id
            WHERE l.id IN (SELECT value FROM json_each(?))`,
        )
          .bind(JSON.stringify(listingIds))
          .all<Record<string, unknown>>()
          .then((r) => r.results)
      : Promise.resolve([] as Record<string, unknown>[]),
    refs.length
      ? env.DB.prepare(
          `SELECT id, listing_ref, buyer_id, status, meetup_time, meetup_location, created_at FROM orders
            WHERE listing_ref IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC`,
        )
          .bind(JSON.stringify(refs))
          .all<OrderRow>()
          .then((r) => r.results)
      : Promise.resolve([] as OrderRow[]),
  ]);

  const listings = new Map(listingRows.map((l) => [String(l.id), l]));

  return rows.map((conv) => {
    const iAmBuyer = conv.buyer_id === viewerId;
    const otherId = iAmBuyer ? conv.seller_id : conv.buyer_id;
    const other = people.get(otherId);
    const listing = conv.listing_id ? listings.get(conv.listing_id) : undefined;

    // The most recent order between this buyer and this listing, preferring
    // one that is not cancelled.
    const mine = orderRows.filter((o) => o.listing_ref === conv.listing_ref && o.buyer_id === conv.buyer_id);
    const order = mine.find((o) => o.status !== 'cancelled') ?? mine[0] ?? null;

    let photo = '';
    if (listing) {
      const photos = parsePhotos(listing.photos);
      photo = photos[0] ?? (typeof listing._cover === 'string' ? listing._cover : '') ?? '';
    }

    return {
      id: conv.id,
      listing_id: conv.listing_ref,
      listing_title: conv.book_title,
      listing_isbn: conv.book_isbn,
      listing_deleted: conv.listing_id === null,
      listing_photo: photo,
      listing_price: listing ? (listing.price as number) : null,
      listing_condition: listing ? (listing.condition as string) : null,
      listing_course: listing ? ((listing.course_name as string | undefined) ?? '') : null,
      other_party: other?.displayName ?? '',
      other_party_role: iAmBuyer ? 'seller' : 'buyer',
      other_party_school_name: schools.get(otherId) ?? '',
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
