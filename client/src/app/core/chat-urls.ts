/**
 * Chat endpoints, served by the same Worker as the app and the API under
 * /api/chat (server/src/routes/chat.ts). `edgeChatUrl` is the base the backend
 * returns as `edge_chat_url` with each chat or hub token — this page's own
 * origin — so nothing here hard-codes a host.
 *
 * Every endpoint authenticates with the room- or hub-scoped token the caller
 * holds: as `Authorization: Bearer` over HTTP, as the WebSocket subprotocol
 * on a socket (the WebSocket API cannot set headers). Never in the URL.
 */

function base(edgeChatUrl: string | null | undefined): string {
  const origin = edgeChatUrl || (typeof location !== 'undefined' ? location.origin : '');
  return `${origin.replace(/\/+$/, '')}/api/chat`;
}

const toSocket = (url: string) => url.replace(/^http/, 'ws');
const room = (edgeChatUrl: string | null | undefined, roomId: string) =>
  `${base(edgeChatUrl)}/rooms/${encodeURIComponent(roomId)}`;

/** ws(s)://<origin>/api/chat/hub — the per-user unread / notification socket. */
export function chatHubSocketUrl(edgeChatUrl: string | null | undefined): string {
  return toSocket(`${base(edgeChatUrl)}/hub`);
}

/** ws(s)://<origin>/api/chat/rooms/<roomId> — one conversation's live socket. */
export function chatRoomSocketUrl(edgeChatUrl: string | null | undefined, roomId: string): string {
  return toSocket(room(edgeChatUrl, roomId));
}

/** GET (history) / POST (send) <origin>/api/chat/rooms/<roomId>/messages. */
export function chatRoomMessagesUrl(edgeChatUrl: string | null | undefined, roomId: string): string {
  return `${room(edgeChatUrl, roomId)}/messages`;
}

/** POST <origin>/api/chat/rooms/<roomId>/read — mark the room read. */
export function chatRoomReadUrl(edgeChatUrl: string | null | undefined, roomId: string): string {
  return `${room(edgeChatUrl, roomId)}/read`;
}
