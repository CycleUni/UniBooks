import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { managedRegionCodes } from '../services/messaging/staffScope';
import { readCapped } from '../lib/body';
import { CHAT_APP_ID, chatRoomStub } from '../lib/chat';
import { verifyToken, InvalidTokenError, type ChatTokenPayload } from '../lib/jwt';
import { accessTokenFrom } from '../lib/session';
import { getConversation, isParticipant, listingDeleted } from '../services/messaging/conversations';
import { isUsable, loadPerson } from '../services/messaging/people';

/**
 * Chat transport, mounted at /api/chat (same origin as the app):
 *
 *   GET  /hub                     per-user hub WebSocket        (session)
 *   GET  /hub/snapshot            unread state                  (session)
 *   GET  /rooms/<roomId>          room WebSocket                (chat token)
 *   GET  /rooms/<roomId>/messages history; POST sends one       (chat token)
 *   POST /rooms/<roomId>/read     mark the room read            (chat token)
 *
 * The hub is the signed-in user's own: it authenticates with the session (the
 * access cookie the browser sends on the upgrade, or `Authorization: Bearer`
 * <access> from API clients), so opening it costs no token request first.
 * Room tokens are minted by /api/v1/messaging/chat-token (cookie-authenticated)
 * and arrive as `Authorization: Bearer` (REST) or as the first
 * Sec-WebSocket-Protocol entry (a browser WebSocket cannot set headers);
 * never in the query string. The hub's own /push and /read are reachable only
 * from ChatRoom over a Durable Object stub, never from here.
 */
export const chatRoutes = new Hono<AppEnv>();

const ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

function extractToken(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const proto = req.headers.get('Sec-WebSocket-Protocol');
  if (proto) return proto.split(',')[0].trim() || null;
  return null;
}

const text = (body: string, status: number) => new Response(body, { status });

/**
 * Re-checked on every connect and request: a token proves who the user was
 * when it was minted, not that the account is still allowed in. A ban or a
 * deactivation takes effect at the next connect instead of at token expiry.
 */
async function accountAllowed(c: Context<AppEnv>, userId: string): Promise<boolean> {
  return isUsable(await loadPerson(c.env, userId));
}

/**
 * Forward to a Durable Object on a fresh internal URL. Only the trusted,
 * token-derived values and the few client parameters the DO reads are put
 * on it, so nothing the client adds to its own URL (a ?userId=, ?role=,
 * ?participantIds=) can reach the DO.
 */
function internalRequest(req: Request, path: string, params: Record<string, string>, body: BodyInit | null = null): Request {
  const url = new URL(`https://chat.internal${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Only what the Durable Objects need: no cookies or credentials ride along.
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The body is never streamed through: only a caller that has read and
  // capped it passes one on.
  return new Request(url.toString(), { method: req.method, headers, body });
}

const FORWARDED_HEADERS = [
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'content-type',
];

/**
 * A chat message is at most a few KB. The body is read with this cap
 * (declared length or not, so a chunked upload cannot slip past it) before
 * it is handed to the room.
 */
const MAX_CHAT_BODY_BYTES = 16 * 1024;

// ─── Per-user hub ─────────────────────────────────────────────────────────

/** A hub socket's life: the app reconnects (re-checking the session) after it. */
const HUB_SOCKET_SECONDS = 24 * 60 * 60;

async function hubUser(c: Context<AppEnv>): Promise<{ userId: string; exp: number } | Response> {
  // Cookies ride on a cross-site WebSocket upgrade too, and sameOriginGuard
  // only covers unsafe methods: refuse another site's page here.
  const origin = c.req.header('Origin');
  const site = c.req.header('Sec-Fetch-Site');
  if ((origin && origin !== new URL(c.req.url).origin) || (site && site !== 'same-origin' && site !== 'none')) {
    return text('Forbidden: Cross-site request', 403);
  }
  const token = accessTokenFrom(c);
  if (!token) return text('Unauthorized: Not signed in', 401);
  let userId: string;
  try {
    ({ user_id: userId } = await verifyToken('access', token, c.env));
  } catch (e) {
    if (e instanceof InvalidTokenError) return text('Unauthorized: Invalid token', 401);
    throw e;
  }
  if (!ID_SEGMENT.test(userId)) return text('Bad Request: invalid user id', 400);
  if (!(await accountAllowed(c, userId))) return text('Forbidden: Account not active', 403);
  return { userId, exp: Math.floor(Date.now() / 1000) + HUB_SOCKET_SECONDS };
}

const hubStub = (c: Context<AppEnv>, userId: string) => c.env.USER_HUB.get(c.env.USER_HUB.idFromName(userId));

chatRoutes.get('/hub', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return text('Expected WebSocket upgrade', 400);
  const hub = await hubUser(c);
  if (hub instanceof Response) return hub;
  return hubStub(c, hub.userId).fetch(internalRequest(c.req.raw, `/ws/user/${hub.userId}`, { userId: hub.userId, exp: String(hub.exp) }));
});

chatRoutes.get('/hub/snapshot', async (c) => {
  const hub = await hubUser(c);
  if (hub instanceof Response) return hub;
  return hubStub(c, hub.userId).fetch(internalRequest(c.req.raw, `/users/${hub.userId}/snapshot`, { userId: hub.userId }));
});

// ─── Rooms ────────────────────────────────────────────────────────────────

interface RoomAccess {
  userId: string;
  role: ChatTokenPayload['role'];
  participantIds: string[];
  exp: number;
}

async function roomAccess(c: Context<AppEnv>, roomId: string): Promise<RoomAccess | Response> {
  if (!ID_SEGMENT.test(roomId)) return text('Bad Request: invalid room id', 400);
  const token = extractToken(c.req.raw);
  if (!token) return text('Unauthorized: Missing token', 401);
  let claims: ChatTokenPayload & { exp: number };
  try {
    claims = await verifyToken('chat', token, c.env);
  } catch (e) {
    if (e instanceof InvalidTokenError) return text('Unauthorized: Invalid token', 401);
    throw e;
  }
  // Both claims must match the path: the room DO is keyed by app and room.
  if (claims.app_id !== CHAT_APP_ID) return text('Forbidden: Token not valid for this app', 403);
  if (claims.room_id !== roomId) return text('Forbidden: Token not valid for this room', 403);
  const person = await loadPerson(c.env, claims.user_id);
  if (!isUsable(person)) return text('Forbidden: Account not active', 403);

  let role: ChatTokenPayload['role'] = claims.role === 'observer' ? 'observer' : 'user';

  // The conversation's current state, not the state at minting: a chat
  // whose listing was deleted since is read-only now, and a room whose
  // conversation is gone (both sides deleted it) is closed.
  const conv = await getConversation(c.env, roomId);
  if (!conv) return text('Not found', 404);
  if (role === 'user') {
    if (!isParticipant(conv, claims.user_id)) return text('Forbidden: Not a participant', 403);
    if (listingDeleted(conv)) role = 'observer';
  } else if (!isParticipant(conv, claims.user_id)) {
    // A non-participant observer is a moderator reading a reported chat;
    // the token outlives a demotion or a region taken away, these checks
    // do not.
    if (!person.isStaff) return text('Forbidden: Not a participant', 403);
    const scope = await managedRegionCodes(c.env, {
      id: person.id,
      email: person.email,
      role: person.isAdmin ? 'admin' : 'staff',
      isStaff: true,
      isAdmin: person.isAdmin,
    });
    if (scope !== null && !scope.includes(conv.region_code)) return text('Forbidden: Region not managed', 403);
  }
  // The participants are the conversation's, read from D1, so a hub push
  // can only ever reach the buyer and the seller of this room.
  return { userId: claims.user_id, role, participantIds: [conv.buyer_id, conv.seller_id], exp: claims.exp };
}

function roomParams(a: RoomAccess): Record<string, string> {
  return {
    userId: a.userId,
    role: a.role,
    exp: String(a.exp),
    participantIds: a.participantIds.join(','),
  };
}

chatRoutes.get('/rooms/:roomId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return text('Expected WebSocket upgrade', 400);
  const roomId = c.req.param('roomId');
  const access = await roomAccess(c, roomId);
  if (access instanceof Response) return access;
  return chatRoomStub(c.env, roomId).fetch(internalRequest(c.req.raw, `/ws/${CHAT_APP_ID}/${roomId}`, roomParams(access)));
});

chatRoutes.on(['GET', 'POST'], '/rooms/:roomId/messages', async (c) => {
  let body: Uint8Array | null = null;
  if (c.req.method === 'POST') {
    body = await readCapped(c.req.raw, MAX_CHAT_BODY_BYTES);
    if (body === null) return text('Payload Too Large', 413);
  }
  const roomId = c.req.param('roomId');
  const access = await roomAccess(c, roomId);
  if (access instanceof Response) return access;
  const params = roomParams(access);
  if (c.req.method === 'GET') {
    for (const k of ['limit', 'before', 'paginated']) {
      const v = c.req.query(k);
      if (v !== undefined) params[k] = v;
    }
  }
  return chatRoomStub(c.env, roomId).fetch(internalRequest(c.req.raw, `/api/${CHAT_APP_ID}/${roomId}/messages`, params, body));
});

chatRoutes.post('/rooms/:roomId/read', async (c) => {
  const roomId = c.req.param('roomId');
  const access = await roomAccess(c, roomId);
  if (access instanceof Response) return access;
  return chatRoomStub(c.env, roomId).fetch(internalRequest(c.req.raw, `/api/${CHAT_APP_ID}/${roomId}/read`, roomParams(access)));
});
