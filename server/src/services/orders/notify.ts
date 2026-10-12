import { and, eq, or } from 'drizzle-orm';
import type { Env } from '../../env';
import { createDb, conversations } from '../../db';
import { postSystemMessage } from '../../lib/chat';

/** The order fields a notice needs. */
export interface NoticeOrder {
  id: string;
  buyerId: string;
  sellerId: string;
  listingId: string | null;
  listingRef: string | null;
  bookTitle: string;
  status: string;
}

/** A notice to send once the write that caused it has committed. */
export interface OrderNotice {
  key: string;
  senderId: string;
  /** Informational only: the chat notice itself carries the push (see deliverNotices). */
  push: boolean;
}

/**
 * The buyer/seller conversation an order was arranged in. Paired on
 * (listing_ref, buyer), so it is still found after the listing
 * is deleted; listing_id is the fallback for a conversation row that carries
 * no snapshot.
 */
export async function findOrderConversation(env: Env, order: Pick<NoticeOrder, 'buyerId' | 'listingId' | 'listingRef'>) {
  const pairs = [];
  if (order.listingRef) pairs.push(eq(conversations.listingRef, order.listingRef));
  if (order.listingId) pairs.push(eq(conversations.listingId, order.listingId));
  if (!pairs.length) return null;
  const [conv] = await createDb(env.DB)
    .select({ id: conversations.id, roomId: conversations.roomId, buyerId: conversations.buyerId, sellerId: conversations.sellerId })
    .from(conversations)
    .where(and(eq(conversations.buyerId, order.buyerId), or(...pairs)))
    .limit(1);
  return conv ?? null;
}

/**
 * Post `[SYSTEM:<key>] System Notification`
 * into the order's conversation, as `senderId`. Best-effort: never throws.
 */
export async function sendOrderNotification(env: Env, order: NoticeOrder, key: string, senderId: string): Promise<boolean> {
  try {
    const conv = await findOrderConversation(env, order);
    if (!conv) return false;
    return await postSystemMessage(env, {
      roomId: conv.roomId,
      participantIds: [conv.buyerId, conv.sellerId],
      senderId,
      content: `[SYSTEM:${key}] System Notification`,
    });
  } catch (e) {
    console.error('[OrderNotify] failed', e);
    return false;
  }
}

/**
 * Send every notice; never throws. Only the chat notice: the room's
 * postSystemMessage already pushes the other party through their hub, so a separate order_update push here
 * would arrive twice.
 */
export async function deliverNotices(env: Env, order: NoticeOrder, notices: OrderNotice[]): Promise<void> {
  for (const n of notices) {
    await sendOrderNotification(env, order, n.key, n.senderId);
  }
}
