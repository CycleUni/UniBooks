import { DurableObject } from 'cloudflare:workers';
import * as Sentry from '@sentry/cloudflare';
import type { Env } from '../env';
import { shouldSendOfflineEmail } from './policies/offlineEmailPolicy';
import { completeClose } from './wsClose';
import { getConversation } from '../services/messaging/conversations';
import { loadPerson } from '../services/messaging/people';
import type { EmailMessage, PushMessage } from '../queues/types';

// Rooms this user has already been emailed about and has not opened since.
// Persisted (not in-memory) because the whole point is to still be true
// after this DO hibernates — which it will, since nobody is connected to it
// while its user is away.
const EMAIL_NOTIFIED_KEY = 'emailNotifiedRooms';

/** Retired per-room read times; deleted on the next mark-read. */
const LEGACY_LAST_READ_KEY = 'lastReadAt';

// Body of a /push call from ChatRoom.
export interface PushPayload {
  room_id: string;
  sender_id: string;
  // The hub's own user, passed explicitly by ChatRoom (which knows the
  // participant list from the sender's signed token) so the email callback
  // can name a recipient even on a hub that has never been connected to.
  recipient_id?: string;
  preview: string;
  timestamp: number;
  self?: boolean;
}

// Minimum time between accepted WebSocket connections for the same user's
// hub, to blunt reconnect-storm abuse (same rationale/value as ChatRoom's
// per-room reconnect throttle).
const MIN_RECONNECT_INTERVAL_MS = 1_000;

/** Close code for an expired token (same as ChatRoom); the app reconnects with a new one. */
const TOKEN_EXPIRED_CLOSE_CODE = 4001;
/** Close code when the hub's account was disabled or deleted (same as ChatRoom). */
const ACCOUNT_DISABLED_CLOSE_CODE = 4003;
/** Upper bound on a socket's life when its token carried no expiry. */
const HUB_MAX_SOCKET_MS = 24 * 60 * 60 * 1000;

// One instance per user (keyed by idFromName(userId)). Holds the single
// WebSocket a client keeps open across its whole visit instead of one per
// open conversation, AND owns the unread-count state for that user.
export class UserHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive from the client's SocketWatch. Answered by the runtime without
    // waking a hibernating object, and never reaches webSocketMessage (or the rate limit).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const userId = url.searchParams.get('userId');
      if (!userId) {
        return new Response('Missing userId', { status: 400 });
      }

      const lastConnectKey = `lastConnect:${userId}`;
      const lastConnect = (await this.ctx.storage.get<number>(lastConnectKey)) || 0;
      if (Date.now() - lastConnect < MIN_RECONNECT_INTERVAL_MS) {
        return new Response('Too Many Requests: reconnecting too fast', { status: 429 });
      }
      await this.ctx.storage.put(lastConnectKey, Date.now());

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      // The socket's expiry: it closes then (TOKEN_EXPIRED_CLOSE_CODE) and the
      // app reconnects, re-checking the session and the account.
      const expSeconds = Number(url.searchParams.get('exp'));
      const expiresAt = Number.isFinite(expSeconds) && expSeconds > 0 ? expSeconds * 1000 : Date.now() + HUB_MAX_SOCKET_MS;
      server.serializeAttachment({ userId, expiresAt });
      await this.scheduleExpiry(expiresAt);
      // Remembered for the offline-email callback, which runs when there is
      // no socket left to read the id off.
      await this.ctx.storage.put('userId', userId);

      const requestedProtocol = request.headers.get('Sec-WebSocket-Protocol');
      const responseHeaders: HeadersInit | undefined = requestedProtocol
        ? { 'Sec-WebSocket-Protocol': requestedProtocol.split(',')[0].trim() }
        : undefined;

      // Send a snapshot right after accept so the client can resync the badge
      // without waiting for the next room_update
      const unread = (await this.ctx.storage.get<string[]>('unread')) || [];
      server.send(JSON.stringify({ type: 'snapshot', unread, count: unread.length }));

      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
    }

    // Internal-only: reached via DO stub call from ChatRoom (env.USER_HUB.get(id).fetch(...))
    if (request.method === 'POST' && url.pathname.endsWith('/push')) {
      const data = (await request.json()) as PushPayload;
      const roomUpdateMsg = JSON.stringify({ type: 'room_update', ...data });
      for (const ws of this.liveSockets()) {
        try {
          ws.send(roomUpdateMsg);
        } catch (e) {
          console.error('Failed to send room_update to socket', e);
        }
      }
      // self: true means the sender's own hub is being notified
      if (!data.self) {
        await this.markUnread(data.room_id);
      }
      await this.maybeSendOfflineEmail(data);
      return new Response('ok');
    }

    // Reconnect-time sync snapshot
    if (request.method === 'GET' && url.pathname.endsWith('/snapshot')) {
      const unread = (await this.ctx.storage.get<string[]>('unread')) || [];
      await this.ctx.storage.put('count', unread.length);
      return Response.json({ unread, count: unread.length });
    }

    // Mark a single room read for this user. POST body: { room_id }
    if (request.method === 'POST' && url.pathname.endsWith('/read')) {
      const { room_id } = (await request.json()) as { room_id: string };
      if (!room_id) return new Response('Missing room_id', { status: 400 });
      await this.markRead(room_id);
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  }

  private async markUnread(roomId: string): Promise<void> {
    const unread = new Set((await this.ctx.storage.get<string[]>('unread')) || []);
    if (unread.has(roomId)) {
      return;
    }
    unread.add(roomId);
    await this.ctx.storage.put('unread', [...unread]);
    await this.ctx.storage.put('count', unread.size);
    const msg = JSON.stringify({ type: 'unread_count', count: unread.size, unread: [...unread] });
    for (const ws of this.liveSockets()) {
      try {
        ws.send(msg);
      } catch (e) {
        console.error('Failed to send unread_count to socket', e);
      }
    }
  }

  private async markRead(roomId: string): Promise<void> {
    await this.clearEmailNotified(roomId);

    // Only the unread set is kept: a per-room read time grew with every room
    // ever opened and no client read it. Older hubs drop theirs here.
    if ((await this.ctx.storage.get(LEGACY_LAST_READ_KEY)) !== undefined) await this.ctx.storage.delete(LEGACY_LAST_READ_KEY);
    const unread = new Set((await this.ctx.storage.get<string[]>('unread')) || []);
    if (!unread.delete(roomId)) return;
    await this.ctx.storage.put('unread', [...unread]);
    await this.ctx.storage.put('count', unread.size);
    const msg = JSON.stringify({ type: 'unread_count', count: unread.size, unread: [...unread] });
    for (const ws of this.liveSockets()) {
      try {
        ws.send(msg);
      } catch (e) {
        console.error('Failed to send unread_count to socket', e);
      }
    }
  }

  private async maybeSendOfflineEmail(data: PushPayload): Promise<void> {
    const notifiedRooms = (await this.ctx.storage.get<string[]>(EMAIL_NOTIFIED_KEY)) || [];
    const decision = shouldSendOfflineEmail({
      roomId: data.room_id,
      isSelf: !!data.self,
      activeSocketCount: this.liveSockets().length,
      notifiedRooms,
    });
    if (!decision) return;

    const recipientId = data.recipient_id || (await this.ctx.storage.get<string>('userId'));
    if (!recipientId) {
      console.error('Offline email skipped: no recipient id for this hub');
      Sentry.captureMessage('Offline email skipped: no recipient id for this hub', 'warning');
      return;
    }

    // Marked before the gate below: whichever channel is
    // off, the next notice waits until they open this conversation.
    await this.ctx.storage.put(EMAIL_NOTIFIED_KEY, [...notifiedRooms, data.room_id]);

    this.ctx.waitUntil(
      this.notifyOffline(recipientId, data).catch((e) => {
        console.error('Offline notification failed', e);
        Sentry.captureException(e);
      }),
    );
  }

  /**
   * Whether the person
   * should hear about it at all (they may have hidden the conversation or
   * left), then each channel on its own switch. The email and the push are
   * rendered by the queue consumers.
   */
  private async notifyOffline(recipientId: string, data: PushPayload): Promise<void> {
    const conv = await getConversation(this.env, data.room_id);
    if (!conv) return;
    let hiddenAt: string | null;
    if (conv.buyer_id === recipientId) hiddenAt = conv.buyer_deleted_at;
    else if (conv.seller_id === recipientId) hiddenAt = conv.seller_deleted_at;
    else {
      console.warn('Offline notification names a non-participant recipient');
      return;
    }
    if (hiddenAt) return;
    const recipient = await loadPerson(this.env, recipientId);
    if (!recipient || recipient.deleted || !recipient.isActive || !recipient.email) return;

    const sends: Promise<unknown>[] = [];
    if (recipient.notifyNewMessageEmail) {
      const email: EmailMessage = {
        type: 'offline_chat_notification',
        recipient_id: recipientId,
        room_id: conv.id,
        sender_id: data.sender_id,
        preview: data.preview,
        conversation_id: conv.id,
        listing_title: conv.book_title,
        region: conv.region_code,
      };
      sends.push(this.env.EMAIL_QUEUE.send(email));
    }
    if (recipient.notifyPush) {
      const push: PushMessage = {
        type: 'chat_message',
        recipient_id: recipientId,
        sender_id: data.sender_id,
        preview: data.preview,
        room_id: conv.id,
        conversation_id: conv.id,
        timestamp: data.timestamp,
        is_offline: true,
      };
      sends.push(this.env.PUSH_QUEUE.send(push));
    }
    await Promise.all(sends);
  }

  private async clearEmailNotified(roomId: string): Promise<void> {
    const notifiedRooms = (await this.ctx.storage.get<string[]>(EMAIL_NOTIFIED_KEY)) || [];
    if (!notifiedRooms.includes(roomId)) return;
    await this.ctx.storage.put(
      EMAIL_NOTIFIED_KEY,
      notifiedRooms.filter((id) => id !== roomId),
    );
  }

  /** Open sockets whose token is still valid; expired ones are closed on the way. */
  private liveSockets(): WebSocket[] {
    const now = Date.now();
    const live: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { expiresAt?: number } | null;
      if (att?.expiresAt !== undefined && att.expiresAt <= now) {
        try {
          ws.close(TOKEN_EXPIRED_CLOSE_CODE, 'Token expired');
        } catch {
          /* already closing */
        }
      } else {
        live.push(ws);
      }
    }
    return live;
  }

  /** Wake up when the earliest socket expires, so idle sockets close too. */
  private async scheduleExpiry(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  /** Close every socket on this hub (its user was disabled or deleted); RPC only. */
  async disconnectAll(): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(ACCOUNT_DISABLED_CLOSE_CODE, 'Account disabled');
        closed++;
      } catch {
        /* already closing */
      }
    }
    return closed;
  }

  async alarm(): Promise<void> {
    const remaining = this.liveSockets();
    const next = remaining
      .map((ws) => (ws.deserializeAttachment() as { expiresAt?: number } | null)?.expiresAt)
      .filter((t): t is number => typeof t === 'number')
      .sort((a, b) => a - b)[0];
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
    completeClose(ws, code, reason);
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {}
}
