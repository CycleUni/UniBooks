import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable, Subject, BehaviorSubject, Subscription, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { uploadImage } from '../upload';
import { environment } from '../../../environments/environment';
import { isTransientHttpFailure } from '../http-failure';
import { decodeJwtPayload } from '../jwt';
import { chatHubSocketUrl, chatRoomMessagesUrl, chatRoomReadUrl, chatRoomSocketUrl } from '../chat-urls';

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

/** The visitor can see the page and the device has a network. */
function isActive(): boolean {
  const visible = typeof document === 'undefined' || !document.hidden;
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  return visible && online;
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
  providedIn: 'root'
})
export class MessageService {
  private http = inject(HttpClient);
  private ws: WebSocket | null = null;
  private currentRoomId: string | null = null;
  private currentToken: string | null = null;
  private currentUserId: string | null = null;
  private platformId = inject(PLATFORM_ID);

  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private delayedReconnectingTimer: ReturnType<typeof setTimeout> | null = null;
  private roomStableTimer: ReturnType<typeof setTimeout> | null = null;
  /** A room reconnect was held back (tab hidden, offline, or out of attempts). */
  private roomReconnectOwed = false;
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
  /** A hub token with more left than this is reused for a reconnect. */
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

  public connectionState$ = new BehaviorSubject<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  /** A room token minted on reconnect; the open conversation's REST calls
   *  (history, older pages) use it in place of the expired one. */
  public roomTokenRefreshed$ = new Subject<{ roomId: string; token: string }>();

  // Single per-user notification connection, independent of whichever
  // conversation (if any) is currently open via connectRoom/ws above.
  // Covers every conversation the user is part of, so the inbox can show
  // live previews/unread badges without opening one socket per conversation.
  private hubWs: WebSocket | null = null;
  private currentHubToken: string | null = null;
  private currentHubUserId: string | null = null;
  private hubReconnectAttempts = 0;
  private hubReconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private hubStableTimer: ReturnType<typeof setTimeout> | null = null;
  private hubReconnectOwed = false;
  private hubClosingIntentionally = false;

  // Opening the hub for a signed-in visitor (openHub), as opposed to
  // reconnecting one that dropped (scheduleHubReconnect).
  private hubOpenWanted = false;
  private hubOpenOwed = false;
  private hubTokenRequest: Subscription | null = null;
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
    const resume = () => { if (isActive()) this.resumeOwed(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
  }

  getConversations(): Observable<any[]> {
    return this.http.get<any>('/messaging/conversations/').pipe(
      map(res => res.results !== undefined ? res.results : res)
    );
  }

  startConversation(listingId: string): Observable<any> {
    return this.http.post<any>('/messaging/conversations/', { listing_id: listingId });
  }

  // Room-scoped: the backend verifies the caller is a participant of this
  // conversation before issuing a token, and the token only works for it.
  getChatToken(conversationId: string): Observable<{token: string}> {
    return this.http.get<{token: string}>('/messaging/chat-token/', {
      params: { conversation_id: conversationId }
    });
  }

  // User-scoped, not room-scoped: proves identity for the single hub
  // connection but grants no access to any conversation's content on its own.
  getHubToken(): Observable<{token: string}> {
    return this.http.get<{token: string}>('/messaging/hub-token/');
  }

  markConversationRead(conversationId: string): Observable<void> {
    return this.http.post<void>(`/messaging/conversations/${conversationId}/read/`, {});
  }

  // Mark a room read via the chat room (/api/chat). The token comes from the
  // room-scoped `getChatToken` call (the API has authorised the caller before
  // minting it), and it names the reader, so no user id travels in the URL.
  postRoomRead(roomId: string, token: string): Observable<void> {
    return this.http.post<void>(
      chatRoomReadUrl(roomId),
      {},
      { headers: { Authorization: `Bearer ${token}`, 'ngsw-bypass': 'true' } }
    );
  }

  deleteConversation(conversationId: string): Observable<{status: string}> {
    return this.http.delete<{status: string}>(`/messaging/conversations/${conversationId}/delete/`);
  }

  // Upload a chat image: compress client-side, then upload in two steps
  // (core/upload.ts). Returns the public URL of the uploaded image.
  uploadChatPhoto(file: File, conversationId: string): Observable<{ url: string }> {
    return from(import('browser-image-compression').then(m => m.default(file, {
      maxSizeMB: 0.5,
      maxWidthOrHeight: 1280,
      initialQuality: 0.7,
      useWebWorker: true,
      fileType: 'image/webp',
    }))).pipe(
      switchMap(compressed =>
        uploadImage(this.http, '/messaging/uploads/', compressed, { conversation_id: conversationId })
      )
    );
  }

  // Chat endpoints (/api/chat, see core/chat-urls.ts). The room token goes in
  // the Authorization header, not the URL, so it doesn't end up in server
  // logs, Referer headers, or browser history. `ngsw-bypass` skips the
  // Angular service worker: these are absolute URLs, so the ApiUrlInterceptor
  // (which only adds the bypass to relative API URLs) never sees them.
  getRoomMessages(roomId: string, token: string): Observable<ChatMessage[]> {
    return this.http.get<ChatMessage[]>(chatRoomMessagesUrl(roomId), {
      headers: { Authorization: `Bearer ${token}`, 'ngsw-bypass': 'true' }
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
    before?: number
  ): Observable<{ messages: ChatMessage[]; has_more: boolean }> {
    let params = new HttpParams().set('paginated', '1').set('limit', String(limit));
    if (before !== undefined) {
      params = params.set('before', String(before));
    }
    return this.http.get<{ messages: ChatMessage[]; has_more: boolean } | ChatMessage[]>(
      chatRoomMessagesUrl(roomId),
      { headers: { Authorization: `Bearer ${token}`, 'ngsw-bypass': 'true' }, params }
    ).pipe(
      // A worker predating the envelope ignores `paginated` and still returns
      // a bare array. Normalise it so the chat isn't blank if the frontend
      // ships before the worker does; no older pages are offered in that
      // case, which is exactly the pre-pagination behaviour.
      map(res => Array.isArray(res) ? { messages: res, has_more: false } : res)
    );
  }

  connectRoom(roomId: string, token: string, userId: string) {
    if (!isPlatformBrowser(this.platformId)) return;
    this.disconnectRoom(false); // Do not clear reconnect state if we are just internally reconnecting, actually wait, if user manually calls connect, we should clear it.

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
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
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

    ws.onclose = () => {
      if (this.ws !== ws) return;
      devLog(`[chat] Disconnected from room ${roomId}`);
      this.ws = null;
      this.clearRoomStableTimer();
      // A deliberate close (switching chats, leaving the page) isn't a send
      // failure — only flag it when the connection dropped on its own,
      // since anything sent right before that will never get its ack now.
      if (!this.closingIntentionally) {
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
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    if (this.reconnectAttempts >= MessageService.MAX_RECONNECT_ATTEMPTS) {
      this.roomReconnectOwed = true;
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, up to max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    devLog(`[chat] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!isActive()) {
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
        this.connectRoom(roomId, res.token, userId, );
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
  sendRoomMessage(content: string, messageType: 'text' | 'image' = 'text', metadata?: Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'message', content, message_type: messageType, metadata }));
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
      this.postRoomRead(this.currentRoomId, this.currentToken)
        .subscribe({ error: () => { } });
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

  /** Pick up whatever was held back while the visitor was away. */
  private resumeOwed(): void {
    if (this.roomReconnectOwed && !this.ws && this.currentRoomId) {
      this.roomReconnectOwed = false;
      this.reconnectAttempts = 0;
      this.scheduleReconnect();
    }
    if (this.hubReconnectOwed && !this.hubWs && this.currentHubUserId) {
      this.hubReconnectOwed = false;
      this.hubReconnectAttempts = 0;
      this.scheduleHubReconnect();
    }
    if (this.readOwed) {
      this.flushRoomRead();
    }
  }

  /**
   * Open the hub for the signed-in visitor: fetch a hub token, then connect.
   *
   * The hub is the only thing that tells the chat server the visitor is on the site;
   * with no socket on it they count as away and get emailed about new
   * messages. scheduleHubReconnect brings back a hub that *dropped*, but
   * nothing brought back one that never opened: the token request ran once,
   * when the session became authenticated, and a failure — a cold serverless
   * start, or the token refresh behind it — went unhandled (logged by Angular
   * as an uncaught ERROR) and left the visitor without a hub until a reload.
   *
   * A transient failure is now retried on a schedule, and again on
   * retryHubIfOwed() (the layout calls it on navigation and on returning to
   * the tab). A 401/403 is not: the session is over, and AuthStore ends it.
   */
  openHub(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.hubOpenWanted = true;
    // Already open (or reconnecting), or a token request is already out.
    if (this.currentHubUserId) return;
    if (this.hubTokenRequest && !this.hubTokenRequest.closed) return;

    this.hubTokenRequest = this.getHubToken().subscribe({
      next: (res) => {
        if (!this.hubOpenWanted) return;
        this.hubOpenOwed = false;
        this.cancelHubOpenRetry();
        // Unreadable token: nothing to connect as.
        const userId = String(decodeJwtPayload(res.token)?.['user_id'] ?? '');
        if (!userId) return;
        this.connectHub(res.token, userId);
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
    if (this.hubOpenOwed && this.hubOpenWanted && !this.currentHubUserId) {
      this.openHub();
    }
  }

  /** The visitor signed out: stop trying to open the hub, and close it. */
  closeHub(): void {
    this.hubOpenWanted = false;
    this.hubOpenOwed = false;
    this.cancelHubOpenRetry();
    this.hubTokenRequest?.unsubscribe();
    this.hubTokenRequest = null;
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

  connectHub(token: string, userId: string) {
    if (!isPlatformBrowser(this.platformId)) return;
    if (this.hubWs && this.currentHubUserId === userId) return;
    this.disconnectHub();
    // disconnectHub() raises the "this close was deliberate" flag for the
    // socket it is tearing down. Lower it again for the one about to be
    // opened: left raised, the first time this connection dropped on its own
    // onclose would read the drop as deliberate and schedule no reconnect,
    // leaving the hub down (and its user looking away to the chat server, which
    // would then email them) until the next login or page load.
    this.hubClosingIntentionally = false;

    this.currentHubToken = token;
    this.currentHubUserId = userId;
    this.hubReconnectAttempts = 0;

    // The hub token names the user; the path no longer does.
    const wsUrl = chatHubSocketUrl();
    // Same superseded-socket guard as connectRoom — see its comment.
    const hubWs = new WebSocket(wsUrl, [token]);
    this.hubWs = hubWs;

    hubWs.onopen = () => {
      if (this.hubWs !== hubWs) return;
      devLog('[chat] Hub connected');
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

    hubWs.onclose = () => {
      if (this.hubWs !== hubWs) return;
      devLog('[chat] Hub disconnected');
      this.hubWs = null;
      this.clearHubStableTimer();
      if (!this.hubClosingIntentionally) {
        this.scheduleHubReconnect();
      }
      this.hubClosingIntentionally = false;
    };
  }

  private scheduleHubReconnect() {
    if (this.hubReconnectTimeout) return;
    if (this.hubReconnectAttempts >= MessageService.MAX_RECONNECT_ATTEMPTS) {
      this.hubReconnectOwed = true;
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.hubReconnectAttempts), 30000);
    this.hubReconnectTimeout = setTimeout(() => {
      this.hubReconnectTimeout = null;
      // Hidden tab or no network: the hub is only there to tell the chat server
      // the visitor is here, and they aren't — being counted away (and
      // emailed about new messages) is right until they come back.
      if (!isActive()) {
        this.hubReconnectOwed = true;
        return;
      }
      this.hubReconnectAttempts++;
      const userId = this.currentHubUserId;
      const staleToken = this.currentHubToken;
      if (!userId || !staleToken) return;

      // Mint a fresh token rather than replaying the cached one: the hub
      // token expires after two hours, so a tab left open past that could
      // never reconnect — every attempt 401s and the retry loop just keeps
      // backing off. That is not only a dead badge: with nothing connected
      // to the hub, the chat server counts the user as away and starts emailing
      // them about messages arriving in a page they are looking at.
      //
      // But only when it is close to expiring. Minting on every attempt
      // meant a chat outage cost a backend request per retry, on top of the
      // retry itself.
      if (tokenSecondsLeft(staleToken) > MessageService.TOKEN_REUSE_MIN_SECONDS) {
        this.reconnectHub(staleToken, userId);
        return;
      }
      this.getHubToken().subscribe({
        next: (res) => this.reconnectHub(res.token, userId, ),
        error: (err: unknown) => {
          // Only a failure that says nothing about the session is worth
          // retrying with the cached token: the backend unreachable (status
          // 0), throttled, or erroring. Anything else means the session is
          // gone — a 401/403 arrives here only after AuthInterceptor tried to
          // refresh and failed (including when no refresh token was left,
          // which it reports as a 401 too). Treating those as transient
          // turned every signed-out tab into a request to the backend every
          // couple of seconds, forever. Stop; signing in again reconnects the
          // hub from the layout.
          const transient = err instanceof HttpErrorResponse &&
            (err.status === 0 || err.status === 429 || err.status >= 500);
          if (!transient) return;
          this.reconnectHub(staleToken, userId);
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
  //    token request was in flight (sign-out clears currentHubUserId),
  //    which would otherwise reopen a hub the layout had just closed.
  private reconnectHub(token: string, userId: string) {
    if (this.currentHubUserId !== userId) return;
    const attempts = this.hubReconnectAttempts;
    this.connectHub(token, userId);
    this.hubReconnectAttempts = attempts;
  }

  disconnectHub() {
    this.clearHubStableTimer();
    this.hubReconnectOwed = false;
    if (this.hubReconnectTimeout) {
      clearTimeout(this.hubReconnectTimeout);
      this.hubReconnectTimeout = null;
    }
    this.hubReconnectAttempts = 0;
    this.currentHubToken = null;
    this.currentHubUserId = null;
    this.hubClosingIntentionally = true;
    this.unreadCount$.next(0);
    this.conversationUnreadState$.next(new Map());

    if (this.hubWs) {
      this.hubWs.close();
      this.hubWs = null;
    }
  }
}
