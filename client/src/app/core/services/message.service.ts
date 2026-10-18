import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable, Subject, BehaviorSubject, Subscription, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { uploadImage } from '../upload';
import { environment } from '../../../environments/environment';
import { isTransientHttpFailure } from '../http-failure';
import { decodeJwtPayload } from '../jwt';
import { SessionRefreshService } from '../session-refresh.service';
import {
  chatHubSocketUrl,
  chatRoomMessagesUrl,
  chatRoomReadUrl,
  chatRoomSocketUrl,
} from '../chat-urls';
import { importOrReload } from '../chunk-recovery';

// Debug logging only outside production, to keep the prod console noise-free.
function devLog(...args: unknown[]): void {
  if (!environment.production) {
    console.log(...args);
  }
}

function devError(...args: unknown[]): void {
  if (!environment.production) {
    console.error(...args);
  }
}

/** Seconds until a JWT's `exp`, or 0 when it cannot be read. */
function tokenSecondsLeft(token: string): number {
  try {
    const payload = decodeJwtPayload(token);
    return typeof payload?.['exp'] === 'number' ? payload['exp'] - Date.now() / 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Reconnect delay: 1s, 2s, 4s, ... up to 30s, each cut by a random 0-50%.
 * After a deploy or restart every client loses its socket at the same moment;
 * without the spread they would all dial again on the same second, every
 * round. Only ever shortened, so a delay is never longer than its schedule.
 */
function backoffDelay(attempts: number): number {
  const base = Math.min(1000 * Math.pow(2, attempts), 30000);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/** The visitor can see the page and the device has a network. */
function isActive(): boolean {
  const visible = typeof document === 'undefined' || !document.hidden;
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  return visible && online;
}

/**
 * Notices a socket that is dead without having closed. After the laptop
 * sleeps or the network changes, the browser can keep reporting OPEN for
 * minutes (or forever): onclose never fires, so nothing reconnects, sends go
 * nowhere and nothing arrives. The server answers 'ping' with 'pong' on its
 * own (setWebSocketAutoResponse), so any frame inside the deadline proves the
 * socket is alive; none means it is dropped as if it had closed.
 */
class SocketWatch {
  static readonly INTERVAL_MS = 25_000;
  static readonly PONG_TIMEOUT_MS = 8_000;
  /** The visitor just came back: a shorter wait, they are looking at it. */
  static readonly RESUME_TIMEOUT_MS = 5_000;

  private answered = true;
  private interval: ReturnType<typeof setInterval>;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ws: WebSocket,
    private onDead: () => void,
  ) {
    this.interval = setInterval(() => this.probe(), SocketWatch.INTERVAL_MS);
  }

  /** Any frame from the server, not only the pong, shows the socket is alive. */
  seen(): void {
    this.answered = true;
  }

  probe(timeoutMs: number = SocketWatch.PONG_TIMEOUT_MS): void {
    if (this.deadline || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.answered = false;
      this.ws.send('ping');
    } catch {
      this.onDead();
      return;
    }
    this.deadline = setTimeout(() => {
      this.deadline = null;
      if (!this.answered) this.onDead();
    }, timeoutMs);
  }

  stop(): void {
    clearInterval(this.interval);
    if (this.deadline) {
      clearTimeout(this.deadline);
      this.deadline = null;
    }
  }
}

export interface ChatMessage {
  id: string;
  user_id: string;
  content: string;
  timestamp: number;
  message_type?: 'text' | 'image';
  metadata?: Record<string, unknown>;
}

export interface RoomUpdate {
  room_id: string;
  sender_id: string;
  preview: string;
  timestamp: number;
  /** True on the sender's own hub: the update is their own message. */
  self?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class MessageService {
  private http = inject(HttpClient);
  private ws: WebSocket | null = null;
  private currentRoomId: string | null = null;
  private currentToken: string | null = null;
  private currentUserId: string | null = null;
  private platformId = inject(PLATFORM_ID);
  private sessionRefresh = inject(SessionRefreshService);

  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private delayedReconnectingTimer: ReturnType<typeof setTimeout> | null = null;
  private roomStableTimer: ReturnType<typeof setTimeout> | null = null;
  /** A room reconnect was held back (tab hidden, offline, or out of attempts). */
  /**
   * Automatic reconnecting has stopped (out of attempts, or held back for a
   * hidden tab) and is waiting for the visitor: the page offers a button then
   * instead of the "reconnecting" badge.
   */
  public roomGaveUp$ = new BehaviorSubject<boolean>(false);
  private get roomReconnectOwed(): boolean {
    return this.roomGaveUp$.value;
  }
  private set roomReconnectOwed(owed: boolean) {
    if (owed !== this.roomGaveUp$.value) this.roomGaveUp$.next(owed);
  }
  private roomWatch: SocketWatch | null = null;
  private lastActivity = Date.now();
  private lastReconnectNow = 0;
  /** The room socket dropped on its own and has not been back yet. */
  private roomDropped = false;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private readOwed = false;

  /**
   * How long a connection has to stay up before its retry count starts over.
   * Resetting on open instead meant a socket that opened and was dropped
   * straight away — the Durable Object reset, "no longer active", 1006 —
   * retried every second forever, and each round cost a token request, the
   * upgrade, and (for the hub) a snapshot fetch with its preflight.
   */
  private static readonly STABLE_CONNECTION_MS = 30_000;
  /**
   * Failed attempts in a row before reconnecting waits for the visitor instead:
   * the next return to the tab, or the network coming back. An unattended tab
   * against a broken server otherwise kept dialing every 30s all night.
   */
  private static readonly MAX_RECONNECT_ATTEMPTS = 8;
  /** A room token with more left than this is reused for a reconnect. */
  /**
   * No input for this long and the page counts as idle: open sockets stay
   * (they keep their heartbeat), but a dropped one is not dialed again until
   * the visitor does something. An open tab nobody is touching otherwise
   * redials for as long as the server is down.
   */
  private static readonly IDLE_MS = 10 * 60_000;
  /** Least time between two visitor-triggered reconnects (reconnectNow). */
  private static readonly RECONNECT_NOW_MIN_MS = 2_000;
  private static readonly TOKEN_REUSE_MIN_SECONDS = 60;
  /** Mark-reads for a burst of live messages collapse into one. */
  private static readonly READ_DEBOUNCE_MS = 1_500;

  // Set right before a deliberate close (switching rooms, leaving the page)
  // so onclose can tell that apart from the connection actually dropping.
  private closingIntentionally = false;

  public realTimeMessages$ = new Subject<ChatMessage>();
  public realTimeDeletions$ = new Subject<string>();
  public realTimeAcks$ = new Subject<{ id: string; timestamp: number }>();
  // Server-side send rejections (rate limit, message too long, ...). Applies
  // to the oldest still-pending send, same correlation-by-order as acks.
  public sendErrors$ = new Subject<string>();

  /** The room socket is back after a drop: messages sent meanwhile were never
   *  delivered to it, so the open conversation should fetch what it missed. */
  public roomReconnected$ = new Subject<void>();
  public connectionState$ = new BehaviorSubject<'connected' | 'reconnecting' | 'disconnected'>(
    'disconnected',
  );
  /** A room token minted on reconnect; the open conversation's REST calls
   *  (history, older pages) use it in place of the expired one. */
  public roomTokenRefreshed$ = new Subject<{ roomId: string; token: string }>();

  // Single per-user notification connection, independent of whichever
  // conversation (if any) is currently open via connectRoom/ws above.
  // Covers every conversation the user is part of, so the inbox can show
  // live previews/unread badges without opening one socket per conversation.
  private hubWs: WebSocket | null = null;
  // Whether a hub connection is wanted and set up (open or reconnecting), and
  // which one: disconnectHub() moves the generation on, so a reconnect that
  // was waiting on a session refresh can tell it has been superseded.
  private hubActive = false;
  private hubGeneration = 0;
  private hubReconnectAttempts = 0;
  private hubReconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private hubStableTimer: ReturnType<typeof setTimeout> | null = null;
  private hubReconnectOwed = false;
  private hubWatch: SocketWatch | null = null;
  private hubClosingIntentionally = false;

  // Opening the hub for a signed-in visitor (openHub), as opposed to
  // reconnecting one that dropped (scheduleHubReconnect).
  private hubOpenWanted = false;
  private hubOpenOwed = false;
  private hubAccessRequest: Subscription | null = null;
  private hubOpenRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  private hubOpenRetryIndex = 0;
  /** Same schedule as AuthStore's profile retry, for the same cold start. */
  private static readonly HUB_OPEN_RETRY_DELAYS_MS = [3000, 10000, 30000];

  public roomUpdates$ = new Subject<RoomUpdate>();
  // Total unread conversation count from the chat UserHub. Kept fresh
  // via hub snapshot + live `unread_count` events, not locally calculated
  // to avoid drift between this and per-conversation unread state.
  public unreadCount$ = new BehaviorSubject<number>(0);

  // Per-conversation unread state from the chat UserHub. Keyed by
  // conversation id (string). Updated from hub snapshot + live events.
  public conversationUnreadState$ = new BehaviorSubject<Map<string, boolean>>(new Map());

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;
    // Reconnects and mark-reads held back while the tab was hidden or the
    // device offline go out when the visitor is back. Root service, so these
    // live as long as the page and need no teardown.
    const resume = () => {
      if (!isActive()) return;
      // A socket that slept through the tab being away may be dead while still
      // reporting OPEN: check it now instead of waiting for the next beat.
      this.roomWatch?.probe(SocketWatch.RESUME_TIMEOUT_MS);
      this.hubWatch?.probe(SocketWatch.RESUME_TIMEOUT_MS);
      this.resumeOwed();
    };
    // Any input is the visitor being here; the first one after an idle spell
    // also picks up the reconnect held back meanwhile. Handlers only compare
    // timestamps, so the busy events cost nothing.
    const touch = () => {
      const wasIdle = this.isIdle();
      this.lastActivity = Date.now();
      if (wasIdle) resume();
    };
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'scroll']) {
      window.addEventListener(type, touch, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
  }

  getConversations(): Observable<any[]> {
    return this.http
      .get<any>('/messaging/conversations')
      .pipe(map((res) => (res.results !== undefined ? res.results : res)));
  }

  startConversation(listingId: string): Observable<any> {
    return this.http.post<any>('/messaging/conversations', { listing_id: listingId });
  }

  // Room-scoped: the backend verifies the caller is a participant of this
  // conversation before issuing a token, and the token only works for it.
  getChatToken(conversationId: string): Observable<{ token: string }> {
    return this.http.get<{ token: string }>('/messaging/chat-token', {
      params: { conversation_id: conversationId },
    });
  }

  // User-scoped, not room-scoped: proves identity for the single hub
  // connection but grants no access to any conversation's content on its own.

  markConversationRead(conversationId: string): Observable<void> {
    return this.http.post<void>(`/messaging/conversations/${conversationId}/read`, {});
  }

  // Mark a room read via the chat room (/api/chat). The token comes from the
  // room-scoped `getChatToken` call (the API has authorised the caller before
  // minting it), and it names the reader, so no user id travels in the URL.
  postRoomRead(roomId: string, token: string): Observable<void> {
    return this.http.post<void>(
      chatRoomReadUrl(roomId),
      {},
      { headers: { Authorization: `Bearer ${token}`, 'ngsw-bypass': 'true' } },
    );
  }

  deleteConversation(conversationId: string): Observable<{ status: string }> {
    return this.http.delete<{ status: string }>(
      `/messaging/conversations/${conversationId}/delete`,
    );
  }

  // Upload a chat image: compress client-side, then upload in two steps
  // (core/upload.ts). Returns the public URL of the uploaded image.
  uploadChatPhoto(file: File, conversationId: string): Observable<{ url: string }> {
    return from(
      importOrReload(() => import('browser-image-compression')).then((m) =>
        m.default(file, {
          maxSizeMB: 0.5,
          maxWidthOrHeight: 1280,
          initialQuality: 0.7,
          useWebWorker: true,
          fileType: 'image/webp',
        }),
      ),
    ).pipe(
      switchMap((compressed) =>
        uploadImage(this.http, '/messaging/uploads', compressed, {
          conversation_id: conversationId,
        }),
      ),
    );
  }

  // Chat endpoints (/api/chat, see core/chat-urls.ts). The room token goes in
  // the Authorization header, not the URL, so it doesn't end up in server
  // logs, Referer headers, or browser history. `ngsw-bypass` skips the
  // Angular service worker: these are absolute URLs, so the ApiUrlInterceptor
  // (which only adds the bypass to relative API URLs) never sees them.
  getRoomMessages(roomId: string, token: string): Observable<ChatMessage[]> {
    return this.http.get<ChatMessage[]>(chatRoomMessagesUrl(roomId), {
      headers: { Authorization: `Bearer ${token}`, 'ngsw-bypass': 'true' },
    });
  }

  /**
   * One page of history, newest first, for the infinite scroll-back in the
   * chat view. `before` is the timestamp (epoch ms) of the oldest message
   * already held, so the next call returns the page immediately older than
   * it; omit it for the initial page.
   *
   * This asks for the `paginated=1` envelope, which carries `has_more`
   * alongside the rows — the plain endpoint returns a bare array with no way
   * to tell "no older messages" from "exactly a full page left".
   */
  getRoomMessagePage(
    roomId: string,
    token: string,
    limit: number,
    before?: number,
  ): Observable<{ messages: ChatMessage[]; has_more: boolean }> {
    let params = new HttpParams().set('paginated', '1').set('limit', String(limit));
    if (before !== undefined) {
      params = params.set('before', String(before));
    }
    return this.http
      .get<{ messages: ChatMessage[]; has_more: boolean } | ChatMessage[]>(
        chatRoomMessagesUrl(roomId),
        { headers: { Authorization: `Bearer ${token}`, 'ngsw-bypass': 'true' }, params },
      )
      .pipe(
        // A worker predating the envelope ignores `paginated` and still returns
        // a bare array. Normalise it so the chat isn't blank if the frontend
        // ships before the worker does; no older pages are offered in that
        // case, which is exactly the pre-pagination behaviour.
        map((res) => (Array.isArray(res) ? { messages: res, has_more: false } : res)),
      );
  }

  connectRoom(roomId: string, token: string, userId: string) {
    if (!isPlatformBrowser(this.platformId)) return;
    this.disconnectRoom(false); // Do not clear reconnect state if we are just internally reconnecting, actually wait, if user manually calls connect, we should clear it.
    // disconnectRoom() raises the "this close was deliberate" flag for the
    // socket it is tearing down. Lower it again for the one about to be
    // opened, as connectHub does: left raised, the first time this connection
    // dropped on its own onclose read the drop as deliberate and scheduled no
    // reconnect, leaving a long-open chat deaf (nothing sent, nothing received).
    this.closingIntentionally = false;

    // We handle the intentional disconnect flag differently here.
    // If it's a completely new connection request, reset state.
    if (this.currentRoomId !== roomId) {
      this.reconnectAttempts = 0;
    }

    this.currentRoomId = roomId;
    this.currentToken = token;
    this.currentUserId = userId;

    // The WebSocket API has no way to set a custom Authorization header, so
    // the token travels as a subprotocol instead of a URL query param —
    // still browser-native, but it doesn't end up in the connect URL.
    const wsUrl = chatRoomSocketUrl(roomId);

    // Captured locally and checked (`this.ws !== ws`) at the top of every
    // handler below. Per-room messages carry no room_id on the wire — the
    // whole connection IS the room — so if an old socket for a previously
    // open conversation is still finishing its close handshake when a new
    // one opens (switching chats quickly, a reconnect racing a manual
    // switch, a server restart mid-switch), its onmessage would otherwise
    // still fire and land in realTimeMessages$, showing up as messages from
    // the wrong conversation in whichever chat is currently active. This
    // guard makes a superseded socket's events into no-ops.
    const ws = new WebSocket(wsUrl, [token]);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      devLog(`[chat] Connected to room ${roomId}`);
      this.roomWatch?.stop();
      this.roomWatch = new SocketWatch(ws, () => dropRoom());
      this.roomReconnectOwed = false;
      this.clearRoomStableTimer();
      this.roomStableTimer = setTimeout(() => {
        this.roomStableTimer = null;
        this.reconnectAttempts = 0;
      }, MessageService.STABLE_CONNECTION_MS);
      // Opening the room is reading it. Sent here rather than over REST
      // before the socket exists; also covers catching up after a reconnect.
      this.clearReadTimer();
      this.flushRoomRead();
      if (this.delayedReconnectingTimer) {
        clearTimeout(this.delayedReconnectingTimer);
        this.delayedReconnectingTimer = null;
      }
      this.connectionState$.next('connected');
      if (this.roomDropped) {
        this.roomDropped = false;
        this.roomReconnected$.next();
      }
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.roomWatch?.seen();
      if (event.data === 'pong') return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message') {
          this.realTimeMessages$.next(data.message);
        } else if (data.type === 'ack') {
          this.realTimeAcks$.next({ id: data.id, timestamp: data.timestamp });
        } else if (data.type === 'message_deleted' || data.type === 'delete_ack') {
          // Both parties have deleted it (message_deleted, broadcast to everyone)
          // or only this user has (delete_ack, sent back to them alone) —
          // either way this client should stop showing the message.
          this.realTimeDeletions$.next(data.id);
        } else if (data.type === 'error') {
          // The stable code first, the English sentence only as a fallback:
          // messages.ts has to recognise a refusal to explain it, and the
          // sentence is whatever the room happens to say today. Its
          // FORBIDDEN_SYSTEM_MESSAGE check has in fact never matched, because
          // only `message` was ever forwarded here.
          this.sendErrors$.next(data.code || data.message || 'Failed to send message');
        }
      } catch (e) {
        devError('Error parsing chat message', e);
      }
    };

    // The socket is gone: it closed, or the watch found it dead without a
    // close. The superseded-socket guard makes the second of the two a no-op.
    const dropRoom = () => {
      if (this.ws !== ws) return;
      devLog(`[chat] Disconnected from room ${roomId}`);
      this.ws = null;
      this.roomWatch?.stop();
      this.roomWatch = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      this.clearRoomStableTimer();
      // A deliberate close (switching chats, leaving the page) isn't a send
      // failure — only flag it when the connection dropped on its own,
      // since anything sent right before that will never get its ack now.
      if (!this.closingIntentionally) {
        this.roomDropped = true;
        this.scheduleReconnect();

        if (!this.delayedReconnectingTimer) {
          this.delayedReconnectingTimer = setTimeout(() => {
            this.connectionState$.next('reconnecting');
            this.sendErrors$.next('Connection lost. Reconnecting...');
            this.delayedReconnectingTimer = null;
          }, 3000);
        }
      } else {
        this.connectionState$.next('disconnected');
      }
      this.closingIntentionally = false;
    };
    ws.onclose = dropRoom;
  }

  /**
   * The visitor wants to use the room (tried to send) while it is not
   * connected: don't make them wait out a backoff, or the give-up after
   * repeated failures.
   */
  reconnectNow(): void {
    if (!this.currentRoomId || this.ws) return;
    // Every Enter press lands here: one nudge per window, so holding the key
    // neither keeps resetting the timer nor adds a dial of its own.
    const now = Date.now();
    if (now - this.lastReconnectNow < MessageService.RECONNECT_NOW_MIN_MS) return;
    this.lastReconnectNow = now;
    this.roomReconnectOwed = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    if (this.reconnectAttempts >= MessageService.MAX_RECONNECT_ATTEMPTS) {
      this.roomReconnectOwed = true;
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, up to max 30s
    const delay = backoffDelay(this.reconnectAttempts);
    devLog(`[chat] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.canRetry()) {
        this.roomReconnectOwed = true;
        return;
      }
      this.reconnectAttempts++;
      if (this.currentRoomId && this.currentToken && this.currentUserId) {
        this.reconnectRoom(this.currentRoomId, this.currentToken, this.currentUserId);
      }
    }, delay);
  }

  /**
   * Reconnect the open room, minting a fresh room token first when the one
   * held is about to expire or has. The room closes a socket whose token
   * has expired (close code 4001), and reconnecting with that
   * same token could only be refused, every attempt, until the user left
   * the conversation and came back. Same reuse rule as the hub's.
   */
  private reconnectRoom(roomId: string, staleToken: string, userId: string): void {
    if (tokenSecondsLeft(staleToken) > MessageService.TOKEN_REUSE_MIN_SECONDS) {
      this.connectRoom(roomId, staleToken, userId);
      return;
    }
    this.getChatToken(roomId).subscribe({
      next: (res) => {
        // The user may have opened another conversation meanwhile.
        if (this.currentRoomId !== roomId) return;
        this.connectRoom(roomId, res.token, userId);
        this.roomTokenRefreshed$.next({ roomId, token: res.token });
      },
      error: () => {
        // Retried later, like a dropped connection: the next attempt mints
        // again, or the visitor returning to the page resumes it.
        if (this.currentRoomId !== roomId) return;
        this.scheduleReconnect();
      },
    });
  }

  disconnectRoom(intentional: boolean = true) {
    this.roomWatch?.stop();
    this.roomWatch = null;
    this.clearRoomStableTimer();
    this.clearReadTimer();
    this.readOwed = false;
    if (intentional) {
      this.roomReconnectOwed = false;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      if (this.delayedReconnectingTimer) {
        clearTimeout(this.delayedReconnectingTimer);
        this.delayedReconnectingTimer = null;
      }
      this.reconnectAttempts = 0;
      this.roomDropped = false;
      // Mark as intentional so onclose doesn't trigger scheduleReconnect()
      // or sendErrors$ — both of which would cause false "send failed" flags
      // on any message that was pending when the socket was closed.
      this.closingIntentionally = true;
      this.connectionState$.next('disconnected');
    } else {
      // Called from connectRoom() when switching rooms. We don't want
      // onclose to trigger sendErrors$ ("Connection lost") since this is a
      // deliberate tear-down, not a network drop. The superseded-socket guard
      // (this.ws !== ws) in onclose already makes it a no-op if a new socket
      // has been assigned before onclose fires, but in case there's any window
      // between ws.close() and the new socket being assigned, flag it too.
      this.closingIntentionally = true;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // Returns false if the message couldn't be sent at all (socket not open),
  // so the caller can flag it as failed immediately instead of waiting on a
  // server round trip that will never come.
  sendRoomMessage(
    content: string,
    messageType: 'text' | 'image' = 'text',
    metadata?: Record<string, unknown>,
  ): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: 'message', content, message_type: messageType, metadata }),
      );
      return true;
    }
    devError('[chat] Cannot send message, WebSocket is not open');
    return false;
  }

  deleteEdgeMessage(id: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'delete', id }));
    } else {
      devError('[chat] Cannot delete message, WebSocket is not open');
    }
  }

  /**
   * Mark the open room read, for a live message the visitor is looking at.
   * Debounced so a burst of messages costs one mark, and sent over the room
   * socket, which (unlike the REST /read with its preflight) is not a billed
   * Worker request. Joining the room marks it read on its own — see onopen.
   */
  markRoomRead(): void {
    if (this.readTimer) return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      this.flushRoomRead();
    }, MessageService.READ_DEBOUNCE_MS);
  }

  private flushRoomRead(): void {
    // A hidden tab isn't reading anything; it catches up when shown again.
    if (!isActive()) {
      this.readOwed = true;
      return;
    }
    this.readOwed = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'read' }));
      return;
    }
    // No socket right now: fall back to the REST endpoint.
    if (this.currentRoomId && this.currentToken && this.currentUserId) {
      this.postRoomRead(this.currentRoomId, this.currentToken).subscribe({ error: () => {} });
    }
  }

  private clearReadTimer(): void {
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
  }

  private clearRoomStableTimer(): void {
    if (this.roomStableTimer) {
      clearTimeout(this.roomStableTimer);
      this.roomStableTimer = null;
    }
  }

  private clearHubStableTimer(): void {
    if (this.hubStableTimer) {
      clearTimeout(this.hubStableTimer);
      this.hubStableTimer = null;
    }
  }

  private isIdle(): boolean {
    return Date.now() - this.lastActivity >= MessageService.IDLE_MS;
  }

  /** A dropped socket may be dialed again: the visitor is here and using the page. */
  private canRetry(): boolean {
    return isActive() && !this.isIdle();
  }

  /** Pick up whatever was held back while the visitor was away. */
  private resumeOwed(): void {
    if (this.roomReconnectOwed && !this.ws && this.currentRoomId) {
      this.roomReconnectOwed = false;
      this.reconnectAttempts = 0;
      this.scheduleReconnect();
    }
    if (this.hubReconnectOwed && !this.hubWs && this.hubActive) {
      this.hubReconnectOwed = false;
      this.hubReconnectAttempts = 0;
      this.scheduleHubReconnect();
    }
    if (this.readOwed) {
      this.flushRoomRead();
    }
  }

  /**
   * Open the hub for the signed-in visitor. The socket signs in with the
   * session cookie, so this costs no request of its own — only a session
   * refresh first when the access cookie has lapsed (shared with the API).
   *
   * The hub is the only thing that tells the chat server the visitor is on the site;
   * with no socket on it they count as away and get emailed about new
   * messages. scheduleHubReconnect brings back a hub that *dropped*, but
   * nothing brought back one that never opened: a refresh failing for a
   * transient reason (a cold serverless start) left the visitor without a hub
   * until a reload.
   *
   * A transient failure is now retried on a schedule, and again on
   * retryHubIfOwed() (the layout calls it on navigation and on returning to
   * the tab). A 401/403 is not: the session is over, and AuthStore ends it.
   */
  openHub(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.hubOpenWanted = true;
    // Already open (or reconnecting), or a refresh for it is already out.
    if (this.hubActive) return;
    if (this.hubAccessRequest && !this.hubAccessRequest.closed) return;

    this.hubAccessRequest = this.sessionRefresh.ensureAccess().subscribe({
      next: () => {
        if (!this.hubOpenWanted) return;
        this.hubOpenOwed = false;
        this.cancelHubOpenRetry();
        this.connectHub();
      },
      error: (err: unknown) => {
        if (!this.hubOpenWanted || !isTransientHttpFailure(err)) return;
        this.hubOpenOwed = true;
        this.scheduleHubOpenRetry();
      },
    });
  }

  /** Open the hub if an earlier attempt failed for a reason worth retrying. */
  retryHubIfOwed(): void {
    if (this.hubOpenOwed && this.hubOpenWanted && !this.hubActive) {
      this.openHub();
    }
  }

  /** The visitor signed out: stop trying to open the hub, and close it. */
  closeHub(): void {
    this.hubOpenWanted = false;
    this.hubOpenOwed = false;
    this.cancelHubOpenRetry();
    this.hubAccessRequest?.unsubscribe();
    this.hubAccessRequest = null;
    this.disconnectHub();
  }

  private scheduleHubOpenRetry(): void {
    if (this.hubOpenRetryTimeout !== null) return;
    const delay = MessageService.HUB_OPEN_RETRY_DELAYS_MS[this.hubOpenRetryIndex];
    // Out of timed retries: the next navigation or return to the tab asks again.
    if (delay === undefined) return;
    this.hubOpenRetryIndex++;
    this.hubOpenRetryTimeout = setTimeout(() => {
      this.hubOpenRetryTimeout = null;
      this.retryHubIfOwed();
    }, delay);
  }

  private cancelHubOpenRetry(): void {
    if (this.hubOpenRetryTimeout !== null) {
      clearTimeout(this.hubOpenRetryTimeout);
      this.hubOpenRetryTimeout = null;
    }
    this.hubOpenRetryIndex = 0;
  }

  connectHub() {
    if (!isPlatformBrowser(this.platformId)) return;
    if (this.hubWs) return;
    // The unread numbers stay: a reconnect after a drop must not blank the
    // badges until the new snapshot lands (it replaces them when it does).
    this.disconnectHub(false);
    // disconnectHub() raises the "this close was deliberate" flag for the
    // socket it is tearing down. Lower it again for the one about to be
    // opened: left raised, the first time this connection dropped on its own
    // onclose would read the drop as deliberate and schedule no reconnect,
    // leaving the hub down (and its user looking away to the chat server, which
    // would then email them) until the next login or page load.
    this.hubClosingIntentionally = false;

    this.hubActive = true;
    this.hubReconnectAttempts = 0;

    // The session cookie names the user: no token, no subprotocol.
    const wsUrl = chatHubSocketUrl();
    // Same superseded-socket guard as connectRoom — see its comment.
    const hubWs = new WebSocket(wsUrl);
    this.hubWs = hubWs;

    hubWs.onopen = () => {
      if (this.hubWs !== hubWs) return;
      devLog('[chat] Hub connected');
      this.hubWatch?.stop();
      this.hubWatch = new SocketWatch(hubWs, () => dropHub());
      this.clearHubStableTimer();
      this.hubStableTimer = setTimeout(() => {
        this.hubStableTimer = null;
        this.hubReconnectAttempts = 0;
      }, MessageService.STABLE_CONNECTION_MS);
      // The unread snapshot arrives as the socket's first message (see
      // onmessage) — no separate REST fetch and preflight per connect.
    };

    hubWs.onmessage = (event) => {
      if (this.hubWs !== hubWs) return;
      this.hubWatch?.seen();
      if (event.data === 'pong') return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'room_update') {
          this.roomUpdates$.next(data as RoomUpdate);
          // Optimistically mark this room as unread so the inbox dot appears
          // immediately. The matching `unread_count` event from the hub will
          // provide the authoritative state shortly after.
          // Not for `self`: the sender's own hub gets the room_update too, so
          // their inbox preview moves, and the hub deliberately skips the
          // unread mark for it — which also means no `unread_count` follows to
          // correct an optimistic mark. Setting one here left a dot on every
          // conversation the user had just written in themselves.
          if (data.room_id && !data.self) {
            const current = this.conversationUnreadState$.value;
            const updated = new Map(current);
            updated.set(data.room_id, true);
            this.conversationUnreadState$.next(updated);
          }
        } else if (data.type === 'unread_count' || data.type === 'snapshot') {
          // `snapshot` is the authoritative state the hub sends on connect,
          // covering the offline gap (events this tab never saw); it has the
          // same shape as a live `unread_count`.
          if (typeof data.count === 'number') {
            this.unreadCount$.next(data.count);
          }
          // Rebuild per-conversation state from the Hub's current unread list.
          if (Array.isArray(data.unread)) {
            const state = new Map<string, boolean>();
            for (const roomId of data.unread) {
              state.set(roomId, true);
            }
            this.conversationUnreadState$.next(state);
          }
        }
      } catch (e) {
        devError('Error parsing hub message', e);
      }
    };

    const dropHub = () => {
      if (this.hubWs !== hubWs) return;
      devLog('[chat] Hub disconnected');
      this.hubWs = null;
      this.hubWatch?.stop();
      this.hubWatch = null;
      try {
        hubWs.close();
      } catch {
        /* already closed */
      }
      this.clearHubStableTimer();
      if (!this.hubClosingIntentionally) {
        this.scheduleHubReconnect();
      }
      this.hubClosingIntentionally = false;
    };
    hubWs.onclose = dropHub;
  }

  private scheduleHubReconnect() {
    if (this.hubReconnectTimeout) return;
    if (this.hubReconnectAttempts >= MessageService.MAX_RECONNECT_ATTEMPTS) {
      this.hubReconnectOwed = true;
      return;
    }

    const delay = backoffDelay(this.hubReconnectAttempts);
    this.hubReconnectTimeout = setTimeout(() => {
      this.hubReconnectTimeout = null;
      // Hidden tab or no network: the hub is only there to tell the chat server
      // the visitor is here, and they aren't — being counted away (and
      // emailed about new messages) is right until they come back.
      if (!this.canRetry()) {
        this.hubReconnectOwed = true;
        return;
      }
      this.hubReconnectAttempts++;
      if (!this.hubActive) return;
      const generation = this.hubGeneration;

      // The socket's 24-hour life ends with a close (4001), and a drop can
      // come after the 15-minute access cookie has lapsed: either way the
      // upgrade needs a live cookie, so refresh first when its hint is gone
      // (no request at all when it is not).
      this.sessionRefresh.ensureAccess().subscribe({
        next: () => this.reconnectHub(generation),
        error: (err: unknown) => {
          // Only a failure that says nothing about the session is worth
          // retrying: the backend unreachable (status 0), throttled, or
          // erroring. A 401/403 means the session is gone (the refresh was
          // refused, or no refresh cookie was left). Treating those as
          // transient turned every signed-out tab into a request to the
          // backend every couple of seconds, forever. Stop; signing in again
          // reconnects the hub from the layout.
          const transient =
            err instanceof HttpErrorResponse &&
            (err.status === 0 || err.status === 429 || err.status >= 500);
          if (!transient) return;
          this.reconnectHub(generation);
        },
      });
    }, delay);
  }

  // The reconnect path into connectHub, which differs from a fresh connect
  // in two ways that both matter for not hammering the backend:
  //  - it keeps the retry count. connectHub resets it (via disconnectHub,
  //    and again itself), so the delay above was 1s on every attempt and
  //    never backed off at all; onopen resets it once a connection succeeds.
  //  - it does nothing if the hub was deliberately disconnected while the
  //    session refresh was in flight (sign-out moves hubGeneration on),
  //    which would otherwise reopen a hub the layout had just closed.
  private reconnectHub(generation: number) {
    if (!this.hubActive || this.hubGeneration !== generation) return;
    const attempts = this.hubReconnectAttempts;
    this.connectHub();
    this.hubReconnectAttempts = attempts;
  }

  /** @param clearUnread false when only tearing down to dial again — signing out clears them. */
  disconnectHub(clearUnread: boolean = true) {
    this.hubWatch?.stop();
    this.hubWatch = null;
    this.clearHubStableTimer();
    this.hubReconnectOwed = false;
    if (this.hubReconnectTimeout) {
      clearTimeout(this.hubReconnectTimeout);
      this.hubReconnectTimeout = null;
    }
    this.hubReconnectAttempts = 0;
    this.hubActive = false;
    this.hubGeneration++;
    this.hubClosingIntentionally = true;
    if (clearUnread) {
      this.unreadCount$.next(0);
      this.conversationUnreadState$.next(new Map());
    }

    if (this.hubWs) {
      this.hubWs.close();
      this.hubWs = null;
    }
  }
}
