import { desc, eq, or } from 'drizzle-orm';
import type { Env } from '../../env';
import { conversations, createDb } from '../../db';
import type { UserHub } from '../../durable-objects/UserHub';
import { chatRoomStub } from '../../lib/chat';

/** Rooms read from D1 per page; every page is closed, however many rooms the user has. */
const ROOMS_PER_PAGE = 200;

/**
 * Close a disabled or deleted user's chat sockets now, instead of when
 * their chat and hub tokens expire (up to an hour and a day): the hub, and
 * every room they take part in. New connections are refused already (the
 * chat routes check the account on connect). Best effort: failures are
 * logged, never thrown, so the account change itself always completes.
 */
export async function disconnectUser(env: Env, userId: string): Promise<void> {
  const hubs = env.USER_HUB as DurableObjectNamespace<UserHub>;
  const tasks: Promise<unknown>[] = [hubs.get(hubs.idFromName(userId)).disconnectAll()];
  try {
    const db = createDb(env.DB);
    for (let offset = 0; ; offset += ROOMS_PER_PAGE) {
      const page = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(or(eq(conversations.buyerId, userId), eq(conversations.sellerId, userId)))
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(ROOMS_PER_PAGE)
        .offset(offset);
      for (const r of page) tasks.push(chatRoomStub(env, r.id).disconnectUser(userId));
      if (page.length < ROOMS_PER_PAGE) break;
    }
  } catch (e) {
    console.error('[chat] could not list rooms to disconnect', e);
  }
  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === 'rejected') console.error('[chat] disconnect failed', r.reason);
  }
}
