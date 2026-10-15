/**
 * Chat endpoints, served by the same Worker as the app and the API under
 * /api/chat (server/src/routes/chat.ts), so every URL is built on this
 * page's own origin and nothing here hard-codes a host.
 *
 * The hub signs in with the session cookie. Room endpoints authenticate with
 * the room-scoped token the caller holds: as `Authorization: Bearer` over
 * HTTP, as the WebSocket subprotocol on a socket (the WebSocket API cannot
 * set headers). Never in the URL.
 */

function base(): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/api/chat`;
}

const toSocket = (url: string) => url.replace(/^http/, 'ws');
const room = (roomId: string) => `${base()}/rooms/${encodeURIComponent(roomId)}`;

/** ws(s)://<origin>/api/chat/hub — the per-user unread / notification socket. */
export function chatHubSocketUrl(): string {
  return toSocket(`${base()}/hub`);
}

/** ws(s)://<origin>/api/chat/rooms/<roomId> — one conversation's live socket. */
export function chatRoomSocketUrl(roomId: string): string {
  return toSocket(room(roomId));
}

/** GET (history) / POST (send) <origin>/api/chat/rooms/<roomId>/messages. */
export function chatRoomMessagesUrl(roomId: string): string {
  return `${room(roomId)}/messages`;
}

/** POST <origin>/api/chat/rooms/<roomId>/read — mark the room read. */
export function chatRoomReadUrl(roomId: string): string {
  return `${room(roomId)}/read`;
}
