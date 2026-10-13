import type { Env } from '../../env';
import type { UserHub } from '../../durable-objects/UserHub';
import { chatRoomStub } from '../../lib/chat';

/** Rooms closed per call: the user's most recently active conversations. */
const MAX_ROOMS = 200;

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
    const { results } = await env.DB.prepare(
      'SELECT id FROM conversations WHERE buyer_id = ? OR seller_id = ? ORDER BY updated_at DESC LIMIT ?',
    )
      .bind(userId, userId, MAX_ROOMS)
      .all<{ id: string }>();
    for (const r of results) tasks.push(chatRoomStub(env, r.id).disconnectUser(userId));
  } catch (e) {
    console.error('[chat] could not list rooms to disconnect', e);
  }
  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === 'rejected') console.error('[chat] disconnect failed', r.reason);
  }
}
