import { DurableObject } from 'cloudflare:workers';
import * as Sentry from '@sentry/cloudflare';
import type { Env } from '../env';
import { isImageUrlAllowed } from './policies/imageUrlPolicy';
import { completeClose } from './wsClose';
import { mayMarkRead } from './policies/markReadPolicy';
import { isSystemMessage } from './policies/systemMessagePolicy';
import { isKnownMessageType, metadataError } from './policies/messagePolicy';
import { IMAGE_PREVIEW_TOKEN, recordLatestMessage } from '../services/messaging/conversations';
import { isChatImageUrl } from '../services/messaging/images';

export { IMAGE_PREVIEW_TOKEN };

/**
 * One chat room (one conversation). Keyed by
 * `unibooks:<roomId>`; the room id is the conversation id.
 *
 * Reached only through routes/chat.ts, which verifies the chat token and
 * passes the trusted values (userId, role, exp, participantIds) on a fresh
 * internal URL, and through the postSystemMessage RPC.
 *
 * Every stored message also updates the conversation's inbox preview in D1
 * and is pushed to both
 * participants' UserHubs, which own unread state and the offline email/push.
 */

interface ConnectionState {
  userId: string;
  role: 'user' | 'system' | 'observer';
  windowStart: number;
  windowCount: number;
  /** When the socket's token expires, in ms; checked on every message. */
  expiresAt?: number;
}

const MAX_MESSAGE_LENGTH = 4000;
const SEND_RATE_LIMIT = 20;
const SEND_RATE_WINDOW_MS = 10_000;
const MIN_RECONNECT_INTERVAL_MS = 1_000;

/** Close code for a socket whose token has expired; the app reconnects with a fresh one. */
export const TOKEN_EXPIRED_CLOSE_CODE = 4001;
/** Close code when the account behind a socket was disabled or deleted. */
export const ACCOUNT_DISABLED_CLOSE_CODE = 4003;

type Validation = { ok: true } | { ok: false; status: number; code?: string; message: string };

export class ChatRoom extends DurableObject<Env> {
  private restRateLimits = new Map<string, { windowStart: number; windowCount: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        content TEXT,
        timestamp INTEGER,
        message_type TEXT DEFAULT 'text',
        metadata TEXT
      )
    `);
    // Rooms created before the image feature lack these columns.
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text'`);
    } catch {
      /* already there */
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN metadata TEXT`);
    } catch {
      /* already there */
    }
    // Per-user "delete for me"; purged once both participants have.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS message_deletions (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id)
      )
    `);
  }

  // ─── RPC ────────────────────────────────────────────────────────────────

  /**
   * Store and broadcast a system-role message (an order notice such as
   * `[SYSTEM:order.notify.seller_approved] System Notification`), push it to
   * both participants' hubs and update the conversation's preview in D1.
   * Called from lib/chat.ts postSystemMessage; never reachable over HTTP.
   */
  async postSystemMessage(args: { roomId: string; participantIds: string[]; senderId: string; content: string }): Promise<boolean> {
    const { roomId, senderId, content } = args;
    const participantIds = (args.participantIds ?? []).map(String).filter(Boolean);
    if (!roomId || !senderId || typeof content !== 'string' || !content) return false;

    await this.ctx.storage.put('roomId', roomId);
    if (participantIds.length) await this.ctx.storage.put('participantIds', participantIds);

    const { id, timestamp } = this.storeAndBroadcast(senderId, content, 'text', null, null);
    await this.afterMessage(roomId, senderId, content, timestamp, 'text');
    return !!id;
  }

  /**
   * Close every socket this user holds in the room (their account was
   * disabled or deleted): their token would otherwise keep the socket open
   * until it expires. Called from services/messaging/disconnect.ts; never
   * reachable over HTTP. Returns how many sockets were closed.
   */
  async disconnectUser(userId: string): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as ConnectionState | undefined;
      if (state?.userId !== userId) continue;
      try {
        ws.close(ACCOUNT_DISABLED_CLOSE_CODE, 'Account disabled');
        closed++;
      } catch {
        /* already closing */
      }
    }
    return closed;
  }

  // ─── HTTP (from routes/chat.ts) ─────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const pathRoomId = pathParts[2] ?? '';

    if (request.headers.get('Upgrade') === 'websocket') {
      const userId = url.searchParams.get('userId');
      if (!userId) return new Response('Missing userId', { status: 400 });

      const lastConnectKey = `lastConnect:${userId}`;
      const lastConnect = (await this.ctx.storage.get<number>(lastConnectKey)) || 0;
      if (Date.now() - lastConnect < MIN_RECONNECT_INTERVAL_MS) {
        return new Response('Too Many Requests: reconnecting too fast', { status: 429 });
      }
      await this.ctx.storage.put(lastConnectKey, Date.now());
      await this.rememberRoom(pathRoomId, url.searchParams.get('participantIds'));

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernation-safe: per-socket state lives on the attachment.
      this.ctx.acceptWebSocket(server);
      const expSeconds = Number(url.searchParams.get('exp'));
      const state: ConnectionState = {
        userId,
        role: parseRole(url.searchParams.get('role')),
        windowStart: Date.now(),
        windowCount: 0,
        expiresAt: Number.isFinite(expSeconds) && expSeconds > 0 ? expSeconds * 1000 : undefined,
      };
      server.serializeAttachment(state);

      // Echo the offered subprotocol (the token) so strict clients accept the handshake.
      const requestedProtocol = request.headers.get('Sec-WebSocket-Protocol');
      const responseHeaders: HeadersInit | undefined = requestedProtocol
        ? { 'Sec-WebSocket-Protocol': requestedProtocol.split(',')[0].trim() }
        : undefined;
      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/messages')) {
      return this.history(url);
    }

    if (request.method === 'POST' && url.pathname.endsWith('/messages')) {
      const userId = url.searchParams.get('userId') || '';
      const role = parseRole(url.searchParams.get('role'));
      let body: Record<string, unknown> = {};
      try {
        const parsed = await request.json();
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        /* empty body */
      }
      const content = body.content;
      const messageType = body.message_type ?? 'text';
      const metadata = body.metadata ?? null;

      if (!content || typeof content !== 'string') return new Response('Missing content', { status: 400 });
      const check = this.validate(role, content, messageType, metadata);
      if (!check.ok) {
        return check.code
          ? new Response(JSON.stringify({ code: check.code, message: check.message }), { status: check.status })
          : new Response(check.message, { status: check.status });
      }
      if (this.isRestRateLimited(userId)) return new Response('Too Many Requests', { status: 429 });

      await this.rememberRoom(pathRoomId, url.searchParams.get('participantIds'));
      const type = messageType as 'text' | 'image';
      const { id, timestamp } = this.storeAndBroadcast(userId, content, type, metadata, null);
      const roomId = pathRoomId || (await this.ctx.storage.get<string>('roomId')) || '';
      await this.afterMessage(roomId, userId, content, timestamp, type);
      return Response.json({ id, timestamp });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/read')) {
      const userId = url.searchParams.get('userId');
      if (!userId) return new Response('Missing userId', { status: 400 });
      const participantIds = url.searchParams.get('participantIds')?.split(',').filter(Boolean);
      // A moderator observing a report has no unread state in this room.
      if (mayMarkRead(parseRole(url.searchParams.get('role')), userId, participantIds)) {
        await this.markReadInHub(userId, pathRoomId);
      }
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  }

  private history(url: URL): Response {
    const requestedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    // Clamped: a caller asking for everything would pull the whole room into memory.
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 200);
    const userId = url.searchParams.get('userId') || '';
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam !== null ? parseInt(beforeParam, 10) : null;
    const hasBefore = before !== null && Number.isFinite(before);

    // One extra row to learn whether an older page exists.
    const probeLimit = limit + 1;
    const cursor = hasBefore
      ? this.ctx.storage.sql.exec(
          `SELECT m.* FROM messages m
           WHERE NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ?)
             AND m.timestamp < ?
           ORDER BY timestamp DESC LIMIT ?`,
          userId,
          before,
          probeLimit,
        )
      : this.ctx.storage.sql.exec(
          `SELECT m.* FROM messages m
           WHERE NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ?)
           ORDER BY timestamp DESC LIMIT ?`,
          userId,
          probeLimit,
        );

    const rows = [...cursor] as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const messages = rows
      .slice(0, limit)
      .map((row) => ({
        ...row,
        message_type: row.message_type || 'text',
        metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      }))
      .reverse();

    // Only paginated callers get the envelope; older clients read a bare array.
    if (url.searchParams.get('paginated') === '1') return Response.json({ messages, has_more: hasMore });
    return Response.json(messages);
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const state = ws.deserializeAttachment() as ConnectionState | undefined;
    if (!state?.userId || typeof message !== 'string') return;
    const userId = state.userId;
    Sentry.setUser({ id: String(userId) });

    if (state.expiresAt !== undefined && Date.now() >= state.expiresAt) {
      try {
        ws.close(TOKEN_EXPIRED_CLOSE_CODE, 'Token expired');
      } catch (e) {
        console.error('Failed to close an expired socket', e);
      }
      return;
    }

    if (this.isRateLimited(ws, state)) {
      this.sendToSender(ws, { type: 'error', message: 'Rate limit exceeded, slow down' });
      return;
    }

    try {
      const data = JSON.parse(message);

      if (state.role === 'observer' && (data.type === 'message' || data.type === 'delete')) {
        this.sendToSender(ws, {
          type: 'error',
          code: 'READ_ONLY_TOKEN',
          message: 'This token may read the room but not write to it',
        });
        return;
      }

      // Mark-read over the socket already open (no billed REST round trip).
      if (data.type === 'read') {
        const participantIds = await this.ctx.storage.get<string[]>('participantIds');
        if (!mayMarkRead(state.role, userId, participantIds)) return;
        const roomId = await this.ctx.storage.get<string>('roomId');
        if (roomId) await this.markReadInHub(userId, roomId);
        return;
      }

      if (data.type === 'message' && data.content) {
        const messageType = data.message_type ?? 'text';
        const metadata = data.metadata ?? null;
        if (messageType === 'image' && typeof data.content !== 'string') {
          this.sendToSender(ws, { type: 'error', message: 'Image content must be a string URL' });
          return;
        }
        if (messageType === 'text' && typeof data.content !== 'string') {
          this.sendToSender(ws, { type: 'error', message: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` });
          return;
        }
        const check = this.validate(state.role, data.content, messageType, metadata);
        if (!check.ok) {
          this.sendToSender(ws, { type: 'error', ...(check.code ? { code: check.code } : {}), message: check.message });
          return;
        }

        const type = messageType as 'text' | 'image';
        const { id, timestamp } = this.storeAndBroadcast(userId, data.content, type, metadata, ws);
        this.sendToSender(ws, { type: 'ack', id, timestamp });

        const roomId = await this.ctx.storage.get<string>('roomId');
        if (roomId) await this.afterMessage(roomId, userId, data.content, timestamp, type);
      } else if (data.type === 'delete' && data.id) {
        this.deleteMessageForUser(ws, userId, String(data.id));
      }
    } catch (e) {
      console.error('Error processing websocket message', e);
      if (!(e instanceof SyntaxError)) Sentry.captureException(e);
      this.sendToSender(ws, { type: 'error', message: 'Malformed message, failed to send' });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
    completeClose(ws, code, reason);
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {}

  // ─── Internals ──────────────────────────────────────────────────────────

  /** The checks every user/observer message passes, on both the socket and REST paths. */
  private validate(role: ConnectionState['role'], content: unknown, messageType: unknown, metadata: unknown): Validation {
    if (role === 'observer') {
      return { ok: false, status: 403, code: 'READ_ONLY_TOKEN', message: 'This token may read the room but not write to it' };
    }
    if (!isKnownMessageType(messageType)) return { ok: false, status: 400, message: 'Invalid message_type' };
    if (typeof content !== 'string') return { ok: false, status: 400, message: 'Missing content' };
    const metaErr = metadataError(metadata);
    if (metaErr) return { ok: false, status: 400, message: metaErr };
    if (messageType === 'text' && content.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, status: 400, message: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` };
    }
    if (messageType === 'image' && !this.imageAllowed(content)) {
      return {
        ok: false,
        status: 400,
        code: 'IMAGE_URL_NOT_ALLOWED',
        message: 'Image content must be an https URL on an allowed host',
      };
    }
    // Control tokens draw official cards in the app; only the server posts them.
    if (role !== 'system' && isSystemMessage(content)) {
      return { ok: false, status: 403, code: 'FORBIDDEN_SYSTEM_MESSAGE', message: 'Users cannot send system messages' };
    }
    return { ok: true };
  }

  /** An image message may only show a chat upload on our own media host. */
  private imageAllowed(url: string): boolean {
    return isImageUrlAllowed(url, this.env.ALLOWED_IMAGE_HOSTS || this.env.R2_PUBLIC_URL) && isChatImageUrl(url, this.env.R2_PUBLIC_URL);
  }

  private async rememberRoom(roomId: string, participantIdsParam: string | null) {
    if (roomId) await this.ctx.storage.put('roomId', roomId);
    if (participantIdsParam) {
      const ids = participantIdsParam.split(',').filter(Boolean);
      if (ids.length) await this.ctx.storage.put('participantIds', ids);
    }
  }

  private storeAndBroadcast(
    userId: string,
    content: string,
    messageType: 'text' | 'image',
    metadata: unknown,
    except: WebSocket | null,
  ): { id: string; timestamp: number } {
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, user_id, content, timestamp, message_type, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      content,
      timestamp,
      messageType,
      metadata ? JSON.stringify(metadata) : null,
    );
    const frame = JSON.stringify({
      type: 'message',
      message: { id, user_id: userId, content, message_type: messageType, metadata, timestamp },
    });
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === except) continue;
      try {
        peer.send(frame);
      } catch (e) {
        console.error('Failed to send broadcast to peer socket', e);
      }
    }
    return { id, timestamp };
  }

  /** Inbox preview in D1, then both participants' hubs. Neither may fail the send. */
  private async afterMessage(roomId: string, senderId: string, content: string, timestamp: number, messageType: string) {
    if (!roomId) return;
    try {
      await recordLatestMessage(this.env, roomId, content, messageType, new Date(timestamp));
    } catch (e) {
      console.error('Inbox preview update failed', e);
      Sentry.captureException(e);
    }
    await this.pushToHubs(roomId, senderId, content, timestamp, messageType);
  }

  private isRestRateLimited(userId: string): boolean {
    const now = Date.now();
    let state = this.restRateLimits.get(userId);
    if (!state) {
      state = { windowStart: now, windowCount: 0 };
      this.restRateLimits.set(userId, state);
    }
    if (now - state.windowStart > SEND_RATE_WINDOW_MS) {
      state.windowStart = now;
      state.windowCount = 1;
      return false;
    }
    state.windowCount += 1;
    return state.windowCount > SEND_RATE_LIMIT;
  }

  private sendToSender(ws: WebSocket, payload: Record<string, unknown>) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      console.error('Failed to send response to sender socket', e);
    }
  }

  private isRateLimited(ws: WebSocket, state: ConnectionState): boolean {
    const now = Date.now();
    if (now - state.windowStart > SEND_RATE_WINDOW_MS) {
      state.windowStart = now;
      state.windowCount = 1;
      ws.serializeAttachment(state);
      return false;
    }
    state.windowCount += 1;
    ws.serializeAttachment(state);
    return state.windowCount > SEND_RATE_LIMIT;
  }

  /**
   * A room_update to each participant's hub (participant ids come from the
   * signed token or the server's RPC, never the client). The sender's own hub
   * is told `self: true` so it does not count the message as unread.
   */
  private async pushToHubs(roomId: string, senderId: string, content: string, timestamp: number, messageType: string) {
    const participantIds = await this.ctx.storage.get<string[]>('participantIds');
    if (!roomId || !participantIds) return;
    const preview = messageType === 'image' ? IMAGE_PREVIEW_TOKEN : content.length > 200 ? content.slice(0, 200) : content;

    await Promise.all(
      participantIds.map((participantId) =>
        this.env.USER_HUB.get(this.env.USER_HUB.idFromName(participantId))
          .fetch('https://internal/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              room_id: roomId,
              sender_id: senderId,
              recipient_id: participantId,
              preview,
              timestamp,
              self: participantId === senderId,
            }),
          })
          .catch((e) => {
            console.error('Hub push failed', e);
            Sentry.captureException(e);
          }),
      ),
    );
  }

  private deleteMessageForUser(ws: WebSocket, userId: string, messageId: string) {
    const exists = [...this.ctx.storage.sql.exec(`SELECT id FROM messages WHERE id = ?`, messageId)].length > 0;
    if (!exists) return;

    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO message_deletions (message_id, user_id) VALUES (?, ?)`, messageId, userId);
    const [{ cnt }] = [
      ...this.ctx.storage.sql.exec(`SELECT COUNT(DISTINCT user_id) as cnt FROM message_deletions WHERE message_id = ?`, messageId),
    ] as { cnt: number }[];

    if (cnt >= 2) {
      // Both parties deleted it: purge for real and tell everyone.
      this.ctx.storage.sql.exec(`DELETE FROM messages WHERE id = ?`, messageId);
      this.ctx.storage.sql.exec(`DELETE FROM message_deletions WHERE message_id = ?`, messageId);
      const purged = JSON.stringify({ type: 'message_deleted', id: messageId });
      for (const peer of this.ctx.getWebSockets()) {
        try {
          peer.send(purged);
        } catch (e) {
          console.error('Failed to send message_deleted to peer socket', e);
        }
      }
    } else {
      this.sendToSender(ws, { type: 'delete_ack', id: messageId });
    }
  }

  private async markReadInHub(userId: string, roomId: string): Promise<void> {
    if (!roomId) return;
    const hub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(userId));
    await hub.fetch('https://internal/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: roomId }),
    });
  }
}

function parseRole(raw: string | null): ConnectionState['role'] {
  // 'system' is never accepted over HTTP: system notices go through the RPC.
  return raw === 'observer' ? 'observer' : 'user';
}
