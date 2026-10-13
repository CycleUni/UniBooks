import type { Env } from '../env';
import { signToken, type ChatTokenPayload } from '../lib/jwt';
import { CHAT_APP_ID } from '../lib/chat';

/**
 * Mint a room token. Shared by the messaging module (participants) and the
 * admin module (moderators reading a reported chat, role 'observer').
 * Chat is served by this same Worker under /api/chat, so the app connects
 * back to the origin it loaded from; no chat URL is handed out.
 */
export async function mintChatToken(
  env: Env,
  args: { userId: string; roomId: string; participantIds: string[]; role: ChatTokenPayload['role'] },
): Promise<string> {
  return signToken(
    'chat',
    {
      user_id: args.userId,
      room_id: args.roomId,
      app_id: CHAT_APP_ID,
      participant_ids: args.participantIds,
      role: args.role,
    },
    env.CHAT_JWT_SECRET,
  );
}

export async function mintHubToken(env: Env, userId: string): Promise<string> {
  return signToken('hub', { user_id: userId }, env.CHAT_JWT_SECRET);
}
