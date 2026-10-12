import type { Env } from '../env';
import { signToken, type ChatTokenPayload } from '../lib/jwt';
import { CHAT_APP_ID } from '../lib/chat';

/**
 * Mint a room token. Shared by the messaging module (participants) and the
 * admin module (moderators reading a reported chat, role 'observer').
 * `edge_chat_url` is the origin the request came in on: chat is served by
 * this same Worker, so the app connects back to wherever it loaded from.
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
    env.EDGE_CHAT_JWT_SECRET,
  );
}

export async function mintHubToken(env: Env, userId: string): Promise<string> {
  return signToken('hub', { user_id: userId }, env.EDGE_CHAT_JWT_SECRET);
}

/** The chat base URL handed to the app: this request's own origin. */
export function chatBaseUrl(requestUrl: string): string {
  return new URL(requestUrl).origin;
}
