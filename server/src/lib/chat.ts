import type { Env } from '../env';
import type { ChatRoom } from '../durable-objects/ChatRoom';

/** Namespace of room Durable Object names (`unibooks:<roomId>`). */
export const CHAT_APP_ID = 'unibooks';

export function chatRoomStub(env: Env, roomId: string) {
  const ns = env.CHAT_ROOM as DurableObjectNamespace<ChatRoom>;
  return ns.get(ns.idFromName(`${CHAT_APP_ID}:${roomId}`));
}

/**
 * Post a system notice into a conversation's room, e.g.
 * `[SYSTEM:order.notify.seller_approved] System Notification`. The room stores and broadcasts it, notifies
 * both participants' hubs, and updates the conversation's last-message
 * fields in D1. Returns false (and logs) on failure; callers treat a
 * notice as best-effort and never fail the order action because of it.
 */
export async function postSystemMessage(
  env: Env,
  args: { roomId: string; participantIds: string[]; senderId: string; content: string },
): Promise<boolean> {
  try {
    return await chatRoomStub(env, args.roomId).postSystemMessage(args);
  } catch (e) {
    console.error('[chat] system message failed', e);
    return false;
  }
}
