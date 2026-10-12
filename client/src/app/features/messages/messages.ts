import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, OnInit, AfterViewChecked, inject, ViewChild, ElementRef, computed } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { UiButton } from '../../shared/ui/button.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiMeetupCard } from '../../shared/ui/meetup-card.component';
import { UiImageLightbox } from '../../shared/ui/image-lightbox.component';
import { UiReportModal } from '../../shared/ui/report-modal.component';
import { UiRoleBadge } from '../../shared/ui/role-badge.component';
import { MessagesInboxList } from './inbox-list.component';
import { UiVerificationPrompt } from '../../shared/ui/verification-prompt.component';
import { FormsModule } from '@angular/forms';
import { MessageService } from '../../core/services/message.service';
import { AuthStore } from '../../core/auth.store';
import { OrderService } from '../../core/services/order.service';
import { MeetupDetailsService } from '../../core/services/meetup-details.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
import { ChangeDetectorRef, OnDestroy } from '@angular/core';
import { TPipe, I18nService } from '../../core/i18n.service';
import { ThemeService } from '../../core/services/theme.service';
import { Subscription, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MobileLayoutService } from '../../core/services/mobile-layout.service';
import { formatMessageTime, isMeetupRequest, isMeetupDetailsMessage, cleanMeetupBody, IMAGE_PREVIEW_TOKEN, systemMessageKey } from './message-formatting.util';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { RegionLinkService } from '../../core/region-link.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { ListingService } from '../../core/services/listing.service';
import { translateApiError } from '../../core/api-error.util';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiPullToRefresh } from '../../shared/ui/pull-to-refresh.component';
import { PendingChatStore, PENDING_CHAT_PREFIX, isPendingChat, pendingChatFromListing } from './pending-chats';
import { decodeJwtPayload } from '../../core/jwt';

/** Listing statuses on which no new conversation can be started. */
const LISTING_GONE_STATUSES = ['removed', 'sold'];
/** Order statuses in which the agreed meetup still means something. */
const MEETUP_DETAIL_STATUSES = ['accepted', 'handed_over'];


@Component({
  selector: 'app-messages',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, UiEmpty, UiButton, UiInput, UiMeetupCard, TPipe, UiImageLightbox, UiReportModal, UiRoleBadge, MessagesInboxList, PricePipe, UiVerificationPrompt, UiSkeleton, UiErrorState, UiPullToRefresh],
  templateUrl: './messages.html',
  styleUrls: ['./messages.css']
})
export class Messages implements OnInit, AfterViewChecked, OnDestroy {
  chats: any[] = [];
  activeChat: any = null;
  messages: any[] = [];
  newMessage = '';
  showUnverifiedPrompt = false;
  chatToken = '';
  edgeChatUrl = '';
  userId = '';
  connectionState: 'connected' | 'reconnecting' | 'disconnected' = 'disconnected';
  imeComposing = false;
  showReport = false;
  refreshingInbox = false;
  // Image upload state
  uploadingImage = false;
  uploadProgress = 0;
  // Lightbox state: the URL alone drives it (empty = closed), so there is
  // no separate open flag that could disagree with it.
  selectedImageUrl = '';
  // Distinguishes "still loading" from "genuinely no conversations" so the
  // empty-inbox state doesn't flash for users who do have conversations,
  // just before loadConversations() resolves.
  loadingChats = true;
  /** The open chat's history is on its way (placeholder bubbles show). */
  loadingHistory = false;
  /** The open chat's history failed to load. */
  historyFailed = false;
  /** The conversation list failed to load: not the same as having none. */
  inboxLoadFailed = false;
  /** A pending chat's conversation is being created by its first message. */
  creatingChat = false;
  /**
   * The first message of a chat that was pending, held until the new
   * conversation's room socket is open: the conversation had no room to
   * send it to when it was written.
   */
  private queuedFirstMessage: { chatId: string; msg: any } | null = null;
  @ViewChild('scrollMe') private myScrollContainer!: ElementRef;
  @ViewChild('fileInput') private fileInput!: HTMLInputElement;
  @ViewChild('inputArea') private inputArea?: ElementRef<HTMLElement>;
  @ViewChild('chatTop') private chatTop?: ElementRef<HTMLElement>;

  private inputAreaResizeObserver?: ResizeObserver;
  private chatTopResizeObserver?: ResizeObserver;
  private observedChatTop?: HTMLElement;
  private observedInputArea?: HTMLElement;

  // History is loaded a page at a time, newest first, and older pages are
  // fetched as the user scrolls back up — a long-running conversation would
  // otherwise ship its entire backlog on open.
  private readonly HISTORY_PAGE_SIZE = 100;
  hasMoreHistory = false;
  loadingOlder = false;
  /** Epoch ms cursor: the oldest message currently held. */
  private oldestTimestamp: number | null = null;

  private messageService = inject(MessageService);
  private authStore = inject(AuthStore);
  private orderService = inject(OrderService);
  private meetupDetails = inject(MeetupDetailsService);
  readonly i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  private theme = inject(ThemeService);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private cdr = inject(ChangeDetectorRef);
  private http = inject(HttpClient);
  private mobileLayout = inject(MobileLayoutService);
  private ga = inject(GoogleAnalyticsService);
  private listingService = inject(ListingService);
  private pendingChats = inject(PendingChatStore);
  private wsSubscription?: Subscription;
  private deletionSubscription?: Subscription;
  private ackSubscription?: Subscription;
  private errorSubscription?: Subscription;
  private connectionSubscription?: Subscription;
  private roomUpdateSubscription?: Subscription;
  private roomTokenSubscription?: Subscription;
  private unreadStateSubscription?: Subscription;
  private queryParamsSubscription?: Subscription;
  private location = inject(Location);
  // Whether the open chat's `?chat=` entry was pushed onto history by this
  // page (opened from the inbox), rather than arrived with (a link, a refresh,
  // the `?listing=` redirect). Only a pushed entry may be popped by the header
  // back button: popping one the user arrived with would leave the site.
  private chatEntryPushed = false;

  private rawEdgeMsgs: any[] = [];
  // Temp ids of messages sent but not yet confirmed by the server, oldest first
  private pendingTempIds: string[] = [];
  // Enter confirming an IME candidate (e.g. Zhuyin) fires `compositionend`
  // and the Enter `keyup` in the same tick, and by then some browsers have
  // already flipped `isComposing` back to false on that keyup — so a plain
  // `event.isComposing` check alone isn't reliable. This flag stays true
  // through that same tick as a fallback, then clears itself.
  private imeJustEnded = false;

  private readonly MAX_DRAFT_LENGTH = 2000;
  private readonly DRAFT_STORAGE_PREFIX = 'unibooks.chat.draft.';

  constructor(private route: ActivatedRoute) { }

  /** Keeps each bubble's DOM across updates: the list is replaced with a new
   *  array on every message, ack and deletion, and without this every bubble
   *  (images included) was torn down and rebuilt each time. */
  trackMessage = (_index: number, msg: { id: string }) => msg.id;

  ngOnInit() {
    this.loadConversations();

    // A reconnect minted a new room token because the old one expired; the
    // history calls below must use it too.
    this.roomTokenSubscription = this.messageService.roomTokenRefreshed$.subscribe(({ roomId, token }) => {
      if (String(this.activeChat?.id) === roomId) this.chatToken = token;
    });

    // Live "new activity" events for every conversation this user is part
    // of, from the single per-user hub connection — not just the one that's
    // currently open — so the inbox can show previews/unread badges without
    // a socket per conversation.
    this.roomUpdateSubscription = this.messageService.roomUpdates$.subscribe(update => {
      const chat = this.chats.find(c => c.id === update.room_id);
      if (!chat) return;

      this.touchInboxRow(chat, update.preview, update.timestamp);
      this.cdr.markForCheck();
    });

    // Unread state lives in CFEdgeChat's UserHub, not Django. Merge the hub's
    // per-conversation unread map into chat objects so the template can show
    // the dot without relying on the removed `unread` serializer field.
    this.unreadStateSubscription = this.messageService.conversationUnreadState$.subscribe(state => {
      for (const chat of this.chats) {
        const conversationId = String(chat.id);
        // The open conversation is being read as messages arrive: the hub
        // briefly lists it as unread until the mark-read call below lands,
        // which flashed a dot on the row the user is looking at.
        (chat as any)._hubUnread = chat.id !== this.activeChat?.id && (state.get(conversationId) ?? false);
      }
      this.cdr.markForCheck();
    });

    this.wsSubscription = this.messageService.realTimeMessages$.subscribe(msg => {
      if (this.activeChat) {
        const exists = this.messages.some(m => m.id === msg.id || (m.id.startsWith('temp_') && m.body === msg.content && m.is_mine));
        if (!exists) {
          this.insertMessageSorted({
            id: msg.id,
            body: msg.content,
            is_mine: String(msg.user_id) === String(this.userId),
            created_at: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
            message_type: msg.message_type || 'text'
          });
        }
        // An image message's content is its URL — show the placeholder
        // instead of a raw https://…/chat/….webp in the inbox preview.
        this.touchInboxRow(
          this.activeChat,
          (msg.message_type || 'text') === 'image' ? IMAGE_PREVIEW_TOKEN : msg.content,
          msg.timestamp || Date.now()
        );

        // Order-status system messages (meetup requested/approved/rejected/
        // cancelled/delivered) change what `isPendingApproval()` should
        // return for the meetup card's buttons — but `activeChat.order_status`
        // is only ever populated from a REST call, never updated by this
        // socket. Without refetching it here, a live-received status change
        // (e.g. the seller declining) wouldn't be reflected until the page
        // is reloaded.
        if (typeof msg.content === 'string' && msg.content.startsWith('[SYSTEM:') && msg.content.includes('order.notify.')) {
          this.refreshOrderStatus();
        }

        this.cdr.markForCheck();
        setTimeout(() => this.scrollToBottom(), 50);

        // Keep the server-side read pointer moving while this chat is
        // actively open, so it doesn't show as unread elsewhere (nav badge,
        // another device) for messages the user is already looking at live.
        this.messageService.markRoomRead();
      }
    });

    this.deletionSubscription = this.messageService.realTimeDeletions$.subscribe(id => {
      this.messages = this.messages.filter(m => m.id !== id);
      this.cdr.markForCheck();
    });

    // Reconcile the optimistic temp bubble with the real server-assigned id
    // (in send order) so deleting a just-sent message targets a real row.
    this.ackSubscription = this.messageService.realTimeAcks$.subscribe(ack => {
      const tempId = this.pendingTempIds.shift();
      const msg = this.messages.find(m => m.id === tempId);
      if (msg) {
        msg.id = ack.id;
        if (ack.timestamp) {
          msg.created_at = new Date(ack.timestamp).toISOString();
          this.sortMessages();
        }
      }
    });

    // A send that got this far (past the synchronous "socket open?" check in
    // sendMessage()) but was rejected by the server, or the socket dropped
    // before an ack came back — same send-order correlation as acks, since a
    // given send resolves to exactly one of ack or error, never both.
    this.errorSubscription = this.messageService.sendErrors$.subscribe((errMsg) => {
      const tempId = this.pendingTempIds.shift();
      const msg = this.messages.find(m => m.id === tempId);
      if (msg) {
        msg.failed = true;
        this.cdr.markForCheck();
      }
      // Refusals from the CFEdgeChat DO that the user can act on. Anything
      // else has already shown itself as the failed marker on the bubble.
      if (errMsg && errMsg.includes('FORBIDDEN_SYSTEM_MESSAGE')) {
        this.toast.error(this.i18n.t('msg.errSystemMessageForbidden'));
      } else if (errMsg && errMsg.includes('IMAGE_URL_NOT_ALLOWED')) {
        // The room only accepts image URLs on the configured upload host, so
        // this is a red bubble with no explanation whatsoever otherwise.
        this.toast.error(this.i18n.t('msg.errImageUrlNotAllowed'));
      }
    });

    this.connectionSubscription = this.messageService.connectionState$.subscribe(state => {
      this.connectionState = state;

      const queued = this.queuedFirstMessage;
      if (state === 'connected' && queued && this.activeChat?.id === queued.chatId) {
        this.queuedFirstMessage = null;
        this.trySend(queued.msg);
      }

      if (state === 'connected' && this.activeChat && this.chatToken && this.edgeChatUrl) {
        // Already loaded via selectChat's eager fetch; don't overwrite
        if (this.messages.length > 0) {
          this.cdr.markForCheck();
          return;
        }
        // Same paginated call selectChat uses. Going through the unpaginated
        // endpoint here instead raced with that initial fetch and whichever
        // landed last won, so the list would sometimes end up holding the
        // old default page size with no way to reach anything older.
        this.fetchHistory(String(this.activeChat.id));
      }

      this.cdr.markForCheck();
    });
  }

  /**
   * The "Conversation with {name}" title split around the name, so the name
   * can be styled as one unbreakable piece. When the name ends the sentence
   * (English), the title may wrap and the name moves to the next line whole;
   * when it sits mid-sentence (Chinese), the title stays on one line.
   */
  get conversationTitle(): { before: string; after: string; nameLast: boolean } {
    const [before, after = ''] = this.i18n.t('msg.conversationWith', { name: '\u0000' }).split('\u0000');
    return { before, after, nameLast: after.trim() === '' };
  }

  ngAfterViewChecked() {
    // The message history reserves space for the fixed input area with
    // padding-bottom. That reserve used to be a hand-guessed 72px, which
    // was too small once the URL bar was showing — the container's bottom
    // edge then lines up with the input instead of sitting above it, so
    // the newest message ended up underneath. Publish the input's real
    // rendered height and let CSS reserve exactly that, the same
    // let-the-browser-measure-it approach .chat-top-fixed uses up top.
    const el = this.inputArea?.nativeElement;
    // Re-observe when the element itself changes: .chat-area is behind an
    // *ngIf, so switching conversations destroys and recreates this node.
    if (el && el !== this.observedInputArea) {
      this.inputAreaResizeObserver?.disconnect();
      this.observedInputArea = el;
      this.inputAreaResizeObserver = new ResizeObserver(() => {
        // Set on the shared ancestor, not the input itself — custom
        // properties inherit down, and .message-history is a sibling.
        const target = el.parentElement ?? el;
        target.style.setProperty('--input-area-height', `${el.offsetHeight}px`);
        // The reserve just changed, so a view pinned to the bottom is now
        // slightly off; re-pin it rather than leaving the last message
        // half-covered until the next scroll.
        this.scrollToBottom(false);
      });
      this.inputAreaResizeObserver.observe(el);
    }

    // Same for the fixed header + listing banner on mobile. Its height used
    // to be a 72px/92px estimate, but the banner grows when its price and
    // condition wrap beside two action buttons, which hid the first messages.
    const top = this.chatTop?.nativeElement;
    if (top && top !== this.observedChatTop) {
      this.chatTopResizeObserver?.disconnect();
      this.observedChatTop = top;
      this.chatTopResizeObserver = new ResizeObserver(() => {
        const target = top.parentElement ?? top;
        target.style.setProperty('--chat-top-height', `${top.offsetHeight}px`);
      });
      this.chatTopResizeObserver.observe(top);
    }
  }

  ngOnDestroy() {
    if (this.activeChat?.id) {
      this.saveDraft(this.activeChat.id, this.newMessage);
    }
    this.inputAreaResizeObserver?.disconnect();
    this.chatTopResizeObserver?.disconnect();
    // The hub connection is owned by the app shell (ui-layout), not this
    // page, so it stays alive across navigation — only disconnectEdgeChat
    // (the per-room connection for whichever chat was open) belongs here.
    this.mobileLayout.setHideBottomNav(false);
    this.messageService.disconnectEdgeChat();
    if (this.wsSubscription) {
      this.wsSubscription.unsubscribe();
    }
    if (this.deletionSubscription) {
      this.deletionSubscription.unsubscribe();
    }
    if (this.ackSubscription) {
      this.ackSubscription.unsubscribe();
    }
    if (this.errorSubscription) {
      this.errorSubscription.unsubscribe();
    }
    if (this.connectionSubscription) {
      this.connectionSubscription.unsubscribe();
    }
    if (this.roomUpdateSubscription) {
      this.roomUpdateSubscription.unsubscribe();
    }
    this.roomTokenSubscription?.unsubscribe();
    this.queryParamsSubscription?.unsubscribe();
    if (this.unreadStateSubscription) {
      this.unreadStateSubscription.unsubscribe();
    }
  }

  loadConversations() {
    this.messageService.getConversations().subscribe({
      next: (data) => {
        // Chats opened in this browser but not written in yet, first — unless
        // the conversation has since been started (on another device).
        const started = new Set(data.map((c: any) => String(c.listing_id)));
        const pending = this.pendingChats.list().filter(c => {
          if (!started.has(String(c.listing_id))) return true;
          this.pendingChats.remove(c.id);
          return false;
        });
        this.chats = [...pending, ...data];
        this.inboxLoadFailed = false;
        // Apply current Hub unread state immediately after loading
        // so re-entering the page shows correct dots without waiting
        // for the next Hub event.
        const currentState = this.messageService.conversationUnreadState$.value;
        for (const chat of this.chats) {
          (chat as any)._hubUnread = currentState.get(String(chat.id)) ?? false;
        }
        this.loadingChats = false;
        this.refreshingInbox = false;

        this.queryParamsSubscription?.unsubscribe();
        this.queryParamsSubscription = this.route.queryParams.subscribe(params => {
          if (params['chat']) {
            const chat = this.chats.find(c => c.id === params['chat']);
            // Opening from the inbox selects first and then writes the URL,
            // which lands back here for the chat already open — while its
            // token is still in flight, so selectChat's own guard (which also
            // wants messages loaded) would fetch everything a second time.
            if (chat && this.activeChat?.id !== chat.id) {
              this.chatEntryPushed = false;
              this.selectChat(chat);
            } else if (!chat && isPendingChat({ id: params['chat'] })) {
              // An unsent chat's URL after a reload: pending chats live only
              // in memory, so rebuild it from the listing (checked afresh).
              this.openPendingChat(String(params['chat']).slice(PENDING_CHAT_PREFIX.length), true);
            }
          } else if (params['listing']) {
            const listingId = params['listing'];
            const existingChat = this.chats.find(c => String(c.listing_id) === String(listingId));
            if (existingChat) {
              this.router.navigate([], { queryParams: { chat: existingChat.id }, replaceUrl: true });
            } else {
              this.openPendingChat(listingId);
            }
          } else if (this.activeChat) {
            // `?chat=` went away underneath an open chat: the browser's Back
            // button popped the entry openChat() pushed. On a phone that is
            // the way back to the inbox, so it has to close the chat.
            this.leaveChat();
          }
          this.cdr.markForCheck();
        });
      },
      error: () => {
        this.loadingChats = false;
        this.refreshingInbox = false;
        // Over a list already showing, a toast; with nothing to show, the
        // error state with its retry, never the "no conversations" one.
        if (this.chats.length > 0) this.toast.error(this.i18n.t('msg.inboxLoadFailed'));
        else this.inboxLoadFailed = true;
        this.cdr.markForCheck();
      }
    });
  }

  onRefreshInbox() {
    this.refreshingInbox = true;
    this.loadConversations();
  }

  /**
   * Contacting a seller about a listing with no conversation yet. Nothing is
   * created on the server: the chat is kept in this browser (PendingChatStore)
   * and becomes a conversation when the first message is sent, so the seller
   * never receives a conversation the buyer left without writing in.
   */
  /**
   * `fromChatUrl`: the URL already names this pending chat (a reload), so
   * navigating to it again would not re-emit the query params — select it here.
   */
  private openPendingChat(listingId: string, fromChatUrl = false) {
    this.loadingChats = true;
    this.listingService.getListing(listingId).subscribe({
      next: (listing) => {
        this.loadingChats = false;
        if (String(listing.seller) === String(this.authStore.user()?.id)) {
          this.toast.error(this.i18n.t('msg.cannotMessageSelf'));
          this.clearChatParam();
          return;
        }
        if (LISTING_GONE_STATUSES.includes(listing.status)) {
          // Taken down or sold: the server would refuse the first message.
          this.toast.error(this.i18n.t('msg.errListingUnavailable'));
          this.clearChatParam();
          return;
        }
        const chat = pendingChatFromListing(listing);
        this.pendingChats.save(chat);
        this.chats = [chat, ...this.chats.filter(c => c.id !== chat.id)];
        if (fromChatUrl) {
          this.chatEntryPushed = false;
          this.selectChat(chat);
          this.cdr.markForCheck();
        } else {
          this.router.navigate([], { queryParams: { chat: chat.id }, replaceUrl: true });
        }
      },
      error: () => {
        this.loadingChats = false;
        this.toast.error(this.i18n.t('msg.chatOpenFailed'));
        this.clearChatParam();
      }
    });
  }

  /**
   * A conversation picked in the inbox. The selection goes into the URL as
   * `?chat=<id>`, the same parameter links from a book page or a notification
   * email use, so a refresh reopens it and it can be shared.
   *
   * Opening a chat from the bare inbox pushes a history entry — on a phone
   * the inbox and the chat are separate screens, and Back must return to the
   * inbox rather than leave the page. Switching from one open chat to
   * another (desktop, where both panes show) replaces it instead, so Back
   * doesn't step through every conversation clicked on the way.
   */
  openChat(chat: any) {
    const switching = !!this.activeChat;
    this.selectChat(chat);
    if (!switching) this.chatEntryPushed = true;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { chat: chat.id },
      replaceUrl: switching,
    });
  }

  /** The chat header's back button. */
  closeChat() {
    this.leaveChat();
    if (this.chatEntryPushed) {
      // Undo our own push instead of adding an inbox entry on top of it,
      // which would make the next Back land on the chat that was just closed.
      this.chatEntryPushed = false;
      this.location.back();
    } else {
      this.clearChatParam();
    }
  }

  private clearChatParam() {
    this.chatEntryPushed = false;
    this.router.navigate([], { relativeTo: this.route, queryParams: { chat: null }, replaceUrl: true });
  }

  /** Closes the open chat's pane without touching the URL. */
  private leaveChat() {
    if (this.activeChat?.id) {
      this.saveDraft(this.activeChat.id, this.newMessage);
    }
    this.newMessage = '';
    this.activeChat = null;
    this.mobileLayout.setHideBottomNav(false);
  }

  /**
   * Moves an inbox row to reflect a message sent or received while this page
   * is open: its preview, its time, and its place at the top (the server
   * orders the inbox by latest activity). Without the move, a refresh was the
   * only way to see a conversation that just had a message jump up the list.
   */
  private touchInboxRow(chat: any, preview: string, timestamp: number) {
    chat.latest_message = preview;
    chat.updated_at = new Date(timestamp).toISOString();
    const index = this.chats.indexOf(chat);
    if (index > 0) {
      this.chats = [chat, ...this.chats.slice(0, index), ...this.chats.slice(index + 1)];
    }
  }

  selectChat(chat: any) {
    if (this.activeChat?.id === chat.id && this.messages.length > 0) return;
    if (this.activeChat?.id && this.activeChat.id !== chat.id) {
      this.saveDraft(this.activeChat.id, this.newMessage);
    }
    this.activeChat = chat;
    this.newMessage = this.loadDraft(chat.id);
    this.mobileLayout.setHideBottomNav(true);
    this.pendingTempIds = [];
    this.messages = [];
    this.rawEdgeMsgs = [];
    this.hasMoreHistory = false;
    this.loadingOlder = false;
    this.oldestTimestamp = null;
    // Before the pending-chat return below: that chat has no history to fail.
    this.historyFailed = false;
    chat._hubUnread = false;

    // Not a conversation yet: no room, token or history to fetch. The last
    // chat's socket is closed so nothing from it lands here.
    if (isPendingChat(chat)) {
      this.loadingHistory = false;
      this.messageService.disconnectEdgeChat();
      return;
    }
    this.loadingHistory = true;
    // Mark read is handled via CFEdgeChat after we fetch the room token

    // Fetch a token scoped to this specific room every time a chat is
    // opened — the backend checks the caller is actually a participant of
    // it, so this can't be used to open someone else's conversation.
    this.messageService.getChatToken(chat.id).subscribe({
      next: (res) => {
        // Responses can arrive out of order when the user switches chats
        // faster than these requests resolve. If a newer selectChat() call
        // has since moved activeChat elsewhere, this response belongs to a
        // conversation the user is no longer looking at — drop it instead
        // of overwriting the token/history/socket for the current one.
        if (this.activeChat?.id !== chat.id) return;

        this.chatToken = res.token;
        this.edgeChatUrl = res.edge_chat_url;
        const tokenUserId = decodeJwtPayload(res.token)?.['user_id'];
        if (tokenUserId != null) this.userId = String(tokenUserId);

        // Not marked read here any more: the room socket marks it on open
        // (MessageService.connectEdgeChat), with no REST call or preflight.

        // Fetch message history immediately via REST — don't wait for the
        // WebSocket connection to reach 'connected' (it may be delayed or
        // fail, leaving the message pane blank).
        this.fetchHistory(String(chat.id));

        this.messageService.connectEdgeChat(chat.id, this.chatToken, this.userId, this.edgeChatUrl);
      },
      error: (err) => {
        console.error('Failed to fetch chat token', err);
        if (this.activeChat?.id !== chat.id) return;
        this.loadingHistory = false;
        this.toast.error(this.i18n.t('msg.chatOpenFailed'));
        this.activeChat = null;
        this.cdr.markForCheck();
      }
    });
  }

  scrollToBottom(force: boolean = true): void {
    try {
      const el = this.myScrollContainer.nativeElement;
      const threshold = 200;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (force || isNearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    } catch (err) { }
  }

  formatMessageTime(dateString: string): string {
    const lang = this.i18n.lang() === 'en' ? 'en-US' : 'zh-TW';
    return formatMessageTime(dateString, lang);
  }

  onCompositionEnd() {
    this.imeComposing = false;
    this.imeJustEnded = true;
    setTimeout(() => { this.imeJustEnded = false; });
  }

  onEnterKey(event: Event) {
    if (this.imeComposing || this.imeJustEnded || (event as KeyboardEvent).isComposing) return;
    this.sendMessage();
  }

  sendMessage() {
    if (isPendingChat(this.activeChat)) {
      const text = this.newMessage.trim();
      if (!text || this.creatingChat) return;
      this.clearDraft(this.activeChat.id);
      this.newMessage = '';
      const tempMsg: any = { id: 'temp_' + Date.now(), body: text, is_mine: true, created_at: new Date().toISOString() };
      this.insertMessageSorted(tempMsg);
      this.cdr.markForCheck();
      this.startPendingChat(this.activeChat, tempMsg);
      return;
    }
    // Block sending if the WebSocket is not fully open. In 'disconnected'
    // state the socket is still being established (initial connect) — sending
    // at that moment causes sendEdgeMessage() to return false and the message
    // is immediately marked as failed before the connection even had a chance
    // to open. 'reconnecting' is already handled, but 'disconnected' was not.
    if (this.connectionState !== 'connected') return;
    if (this.newMessage.trim() && this.activeChat) {
      const text = this.newMessage.trim();
      const chatId = this.activeChat.id;
      this.clearDraft(chatId);
      this.newMessage = '';

      const tempMsg: any = {
        id: 'temp_' + Date.now(),
        body: text,
        is_mine: true,
        created_at: new Date().toISOString()
      };
      this.insertMessageSorted(tempMsg);
      this.touchInboxRow(this.activeChat, text, Date.now());
      this.cdr.markForCheck();
      setTimeout(() => this.scrollToBottom(), 10);

      this.trySend(tempMsg);
    }
  }

  retryMessage(msg: any) {
    msg.failed = false;
    this.cdr.markForCheck();
    if (isPendingChat(this.activeChat)) {
      this.startPendingChat(this.activeChat, msg);
      return;
    }
    this.trySend(msg);
  }

  /**
   * The first message of a pending chat: creates the conversation, swaps it
   * in for the pending chat (inbox row, URL), and sends the message once the
   * new room's socket is open (see connectionState$ in ngOnInit).
   */
  private startPendingChat(pending: any, msg: any) {
    this.creatingChat = true;
    this.messageService.startConversation(pending.listing_id).subscribe({
      next: (conversation) => {
        this.creatingChat = false;
        this.pendingChats.remove(pending.id);
        conversation.latest_message = msg.body;
        conversation.updated_at = new Date().toISOString();
        const index = this.chats.indexOf(pending);
        this.chats = index >= 0
          ? [...this.chats.slice(0, index), conversation, ...this.chats.slice(index + 1)]
          : [conversation, ...this.chats];
        if (this.activeChat !== pending) {
          this.cdr.markForCheck();
          return;
        }
        this.selectChat(conversation);
        this.messages = [msg];
        this.queuedFirstMessage = { chatId: conversation.id, msg };
        this.touchInboxRow(conversation, msg.body, Date.now());
        this.router.navigate([], { relativeTo: this.route, queryParams: { chat: conversation.id }, replaceUrl: true });
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.creatingChat = false;
        msg.failed = true;
        const code = err?.error?.error?.code;
        if (code === 'msg.errListingUnavailable') {
          // The seller took the listing down while this chat sat unsent:
          // there is nobody to write to about it any more.
          this.toast.error(this.i18n.t('msg.errListingUnavailable'));
          this.pendingChats.remove(pending.id);
          this.chats = this.chats.filter(c => c !== pending);
          if (this.activeChat === pending) this.closeChat();
        } else if (err?.status === 403 || code === 'auth.errNotVerified' || code === 'acct.errUnverified') {
          this.showUnverifiedPrompt = true;
        } else {
          this.toast.error(this.i18n.t('msg.chatOpenFailed'));
        }
        this.cdr.markForCheck();
      }
    });
  }

  private trySend(msg: any) {
    const sent = this.messageService.sendEdgeMessage(msg.body, msg.message_type || 'text', msg.metadata);
    if (sent) {
      this.ga.trackSendMessage(this.activeChat?.id);
      // Resolved later by realTimeAcks$ (success) or sendErrors$ (failure).
      this.pendingTempIds.push(msg.id);
    } else {
      // Socket wasn't even open — no point waiting for a response that will
      // never arrive, flag it as failed right away.
      msg.failed = true;
      this.cdr.markForCheck();
    }
  }

  // Image upload handling
  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.activeChat) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      this.toast.error(this.i18n.t('msg.errInvalidImageType'));
      input.value = '';
      return;
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      this.toast.error(this.i18n.t('msg.errImageTooLarge'));
      input.value = '';
      return;
    }

    this.uploadingImage = true;
    this.uploadProgress = 0;
    this.cdr.markForCheck();

    this.messageService.uploadChatPhoto(file, this.activeChat.id).subscribe({
      next: (res) => {
        this.uploadProgress = 100;
        this.cdr.markForCheck();

        // Send the image message
        const tempMsg: any = {
          id: 'temp_' + Date.now(),
          body: res.url,
          message_type: 'image',
          metadata: { filename: file.name },
          is_mine: true,
          created_at: new Date().toISOString()
        };
        this.messages.push(tempMsg);
        this.touchInboxRow(this.activeChat, IMAGE_PREVIEW_TOKEN, Date.now());
        this.cdr.markForCheck();
        setTimeout(() => this.scrollToBottom(), 10);

        this.trySend(tempMsg);

        // Reset
        this.uploadingImage = false;
        this.uploadProgress = 0;
        input.value = '';
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.uploadingImage = false;
        this.uploadProgress = 0;
        input.value = '';
        this.cdr.markForCheck();
        console.error('Image upload failed', err);
        this.toast.error(this.i18n.t('msg.uploadFailed'));
      }
    });
  }

  openImageModal(url: string, event?: Event) {
    if (event) {
      const img = event.target as HTMLImageElement;
      if (img.classList.contains('expired')) {
        return; // Don't open modal if image is expired
      }
    }
    this.selectedImageUrl = url;
  }

  closeImageModal() {
    this.selectedImageUrl = '';
  }

  readonly expiredImageSrc = computed(() => {
    // Read the signal so this computed updates when language changes
    this.i18n.lang();
    // ...and again for the theme. A data: URI is its own document, so the
    // custom properties on :root are not visible inside it and the SVG
    // cannot say var(--paper-warm). The values have to be read out here and
    // baked into the string, which means this has to recompute when the
    // theme changes or the placeholder stays light grey on a dark page.
    this.theme.resolved();
    const css: CSSStyleDeclaration | null =
      typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
    const token = (name: string, fallback: string) =>
      (css?.getPropertyValue(name) ?? '').trim() || fallback;
    const bg = token('--paper-warm', '#f3f4f6');
    const ink = token('--muted', '#9ca3af');
    const fallbackMsg = this.i18n.t('msg.imageLoadFailed') || '';
    const svg = `<svg width="200" height="150" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${bg}" rx="8"/><text x="50%" y="50%" font-family="sans-serif" font-size="14" fill="${ink}" text-anchor="middle" dominant-baseline="middle">${fallbackMsg}</text></svg>`;
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  });

  /**
   * A plain chat bubble's text. Order notices that are not meetup cards (a
   * platform cancel, say) arrive as `[SYSTEM:<key>] System Notification` and
   * were printed as exactly that; show the translated notice instead.
   */
  messageText(body: string): string {
    const key = systemMessageKey(body);
    return key ? (this.i18n.tOrNull(key) ?? body) : body;
  }

  onImageError(msg: any) {
    msg._expired = true;
    this.cdr.markForCheck();
  }

  async deleteMessage(id: string) {
    if (!id.startsWith('temp_')) {
      const confirmed = await this.confirms.askDanger(
        this.i18n.t('msg.confirmDeleteMessage'),
        { confirmLabel: this.i18n.t('common.delete') }
      );
      if (!confirmed) return;
    }

    // Hide it locally right away; realTimeDeletions$ (delete_ack) will
    // confirm the same removal, and it becomes a no-op filter by then.
    this.messages = this.messages.filter(m => m.id !== id);
    this.cdr.markForCheck();
    // A message that never made it past sending has nothing to delete
    // server-side.
    if (!id.startsWith('temp_')) {
      this.messageService.deleteEdgeMessage(id);
    }
  }

  goToListing(listingId?: string) {
    if (listingId) {
      this.router.navigate(this.regionLink.path(['/listing', listingId]));
    }
  }

  goToCheckout(listingId?: string) {
    if (listingId) {
      this.router.navigate(this.regionLink.path(['/checkout', listingId]));
    }
  }

  goToOrder() {
    if (this.activeChat?.order_id) {
      this.router.navigate(this.regionLink.path(['/account/orders']), { queryParams: { orderId: this.activeChat.order_id } });
    } else {
      this.router.navigate(this.regionLink.path(['/account/orders']));
    }
  }

  private extractArray(data: any): any[] {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.results)) return data.results;
    return [];
  }

  /** Maps one raw CFEdgeChat row to the shape the template renders. */
  private toViewMessage(m: any) {
    const bodyText = m.content || m.body || '';
    const createdDate = m.timestamp ? new Date(m.timestamp).toISOString() : (m.created_at ? new Date(m.created_at).toISOString() : new Date().toISOString());
    const isMine = m.user_id
      ? String(m.user_id) === String(this.userId)
      : (m.is_mine !== undefined ? Boolean(m.is_mine) : false);

    return {
      id: m.id || bodyText,
      body: bodyText,
      is_mine: isMine,
      created_at: createdDate,
      message_type: m.message_type || 'text'
    };
  }

  /**
   * Fires as the history scrolls. Once the user is within a screenful of the
   * top, pull the next page of older messages so it arrives before they hit
   * the actual edge.
   */
  onHistoryScroll(): void {
    if (this.loadingOlder || !this.hasMoreHistory) return;
    const el = this.myScrollContainer?.nativeElement;
    if (!el) return;
    if (el.scrollTop <= el.clientHeight) {
      this.loadOlderMessages();
    }
  }

  private loadOlderMessages(): void {
    const chat = this.activeChat;
    if (!chat || this.loadingOlder || !this.hasMoreHistory) return;
    if (this.oldestTimestamp === null) return;

    const el = this.myScrollContainer?.nativeElement;
    this.loadingOlder = true;
    this.cdr.markForCheck();

    this.messageService.getEdgeMessagePage(
      chat.id, this.chatToken, this.edgeChatUrl, this.HISTORY_PAGE_SIZE, this.oldestTimestamp
    ).subscribe({
      next: (page) => {
        // The user may have switched conversations while this was in flight.
        if (this.activeChat?.id !== chat.id) return;

        const older = (page?.messages || []).map(m => this.toViewMessage(m));
        this.hasMoreHistory = !!page?.has_more;

        if (older.length) {
          // Prepending grows the content upward, which would yank the viewport
          // away from whatever the user was reading. Anchor on a real element
          // — the message currently at the top — and shift the scroll by how
          // far that exact node moved. Deriving it from scrollHeight instead
          // drifts by the height of the "loading earlier" row, which is still
          // in the layout when the offset is captured but gone by the time
          // the correction lands (measured: a 51px jump).
          const anchor: HTMLElement | null = el ? el.querySelector('.msg-bubble') : null;
          const anchorTopBefore = anchor?.offsetTop ?? 0;

          const existing = new Set(this.messages.map(m => m.id));
          this.messages = [...older.filter(m => !existing.has(m.id)), ...this.messages];
          this.oldestTimestamp = this.earliestTimestamp();
          this.loadingOlder = false;
          // Render the new page and drop the loading row in one pass, so the
          // anchor is re-measured against the DOM the user ends up seeing.
          this.cdr.detectChanges();

          if (el && anchor) {
            el.scrollTop += anchor.offsetTop - anchorTopBefore;
          }
        }

        this.loadingOlder = false;
        this.cdr.markForCheck();
      },
      error: () => {
        if (this.activeChat?.id !== chat.id) return;
        this.loadingOlder = false;
        this.cdr.markForCheck();
      }
    });
  }

  /** Epoch ms of the oldest message held, or null when there are none. */
  private earliestTimestamp(): number | null {
    let earliest: number | null = null;
    for (const m of this.messages) {
      // Optimistic sends carry a local timestamp that doesn't exist server
      // side yet, so they must not become the pagination cursor.
      if (m.id && String(m.id).startsWith('temp_')) continue;
      const t = new Date(m.created_at).getTime();
      if (!Number.isFinite(t)) continue;
      if (earliest === null || t < earliest) earliest = t;
    }
    return earliest;
  }

  /**
   * The open chat's latest page of history. Both selectChat's eager fetch and
   * the socket's first 'connected' use it, so a failure the first one hit is
   * retried by the second.
   */
  private fetchHistory(chatId: string) {
    this.messageService.getEdgeMessagePage(
      chatId, this.chatToken, this.edgeChatUrl, this.HISTORY_PAGE_SIZE
    ).subscribe({
      next: (page) => {
        if (String(this.activeChat?.id) !== chatId) return;
        this.historyFailed = false;
        this.hasMoreHistory = !!page?.has_more;
        this.setEdgeMessages(page?.messages || []);
      },
      error: (err) => {
        console.error('[fetchHistory] getEdgeMessagePage failed:', err);
        if (String(this.activeChat?.id) !== chatId) return;
        this.hasMoreHistory = false;
        this.setEdgeMessages([]);
        // An empty pane after a failed fetch would read as "no messages yet".
        this.historyFailed = true;
      }
    });
  }

  retryHistory() {
    if (!this.activeChat || !this.chatToken) return;
    this.historyFailed = false;
    this.loadingHistory = true;
    this.fetchHistory(String(this.activeChat.id));
  }

  retryInbox() {
    this.inboxLoadFailed = false;
    this.loadingChats = true;
    this.loadConversations();
  }

  private setEdgeMessages(edgeMsgsInput: any) {
    if (edgeMsgsInput !== undefined) {
      this.rawEdgeMsgs = this.extractArray(edgeMsgsInput);
      console.log('[setEdgeMessages] extracted messages count:', this.rawEdgeMsgs.length,
        'first msg body:', this.rawEdgeMsgs[0]?.content?.substring(0, 80));
    }

    const newMessages = this.rawEdgeMsgs.map(m => this.toViewMessage(m));
    this.loadingHistory = false;

    // Preserve any pending optimistic messages that are currently in flight
    const pendingOptimistic = this.messages.filter(m => m.id && String(m.id).startsWith('temp_') && !newMessages.some(nm => nm.body === m.body && nm.is_mine));

    this.messages = [...newMessages, ...pendingOptimistic].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    this.oldestTimestamp = this.earliestTimestamp();

    this.cdr.markForCheck();
    setTimeout(() => this.scrollToBottom(true), 50);
    setTimeout(() => this.scrollToBottom(true), 500); // Backup for slow rendering
  }

  private insertMessageSorted(msg: any): void {
    const msgTime = new Date(msg.created_at).getTime();
    let low = 0;
    let high = this.messages.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const midTime = new Date(this.messages[mid].created_at).getTime();
      if (midTime <= msgTime) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    this.messages.splice(low, 0, msg);
  }

  private sortMessages(): void {
    this.messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  private isMeetupRequestMsg(msg: any): boolean {
    if (!msg || !msg.body) return false;
    const isSystemMeetupRequest = msg.body.startsWith('[SYSTEM:') && msg.body.includes('order.notify.meetup_requested');
    return isSystemMeetupRequest || msg.body === '[MEETUP_REQUEST]';
  }

  isPendingApproval(msg: any): boolean {
    if (!this.activeChat || !this.isMeetupRequestMsg(msg)) return false;

    const orderIsAwaitingApproval =
      this.activeChat.order_status === 'awaiting_approval' || this.activeChat.order_status === 'pending';
    if (!orderIsAwaitingApproval) return false;

    // A conversation can accumulate more than one meetup-request message
    // over time (e.g. declined, then buyer requests again) — only the most
    // recent one is still actionable; earlier ones must show as processed,
    // regardless of the current order's status.
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.isMeetupRequestMsg(this.messages[i])) {
        return this.messages[i].id === msg.id;
      }
    }
    return false;
  }

  isMeetupRequest(body: string): boolean {
    return isMeetupRequest(body);
  }

  cleanMeetupBody(body: string): string {
    return cleanMeetupBody(body);
  }


  // Re-resolves activeChat.order_id/order_status from the server, always —
  // unlike getOrFetchOrderId, which short-circuits once order_id is cached.
  // Used when a live system message signals the order's status may have
  // just changed underneath the cached value.
  private refreshOrderStatus() {
    if (!this.activeChat?.listing_id) return;
    const chat = this.activeChat;

    this.orderService.getOrders().subscribe({
      next: (orders: any) => {
        const orderList = Array.isArray(orders) ? orders : (orders.results || []);
        const matching = orderList.find((o: any) => {
          const lId = typeof o.listing === 'object' ? o.listing?.id : o.listing;
          return String(lId) === String(chat.listing_id);
        });
        if (matching && this.activeChat === chat) {
          chat.order_id = matching.id;
          chat.order_status = matching.status;
          this.applyMeetupDetails(chat, matching);
          this.cdr.markForCheck();
        }
      },
      error: () => { /* stale status is recovered on next reload/refresh */ }
    });
  }

  private getOrFetchOrderId(callback: (orderId: string) => void) {
    if (this.activeChat?.order_id) {
      callback(this.activeChat.order_id);
      return;
    }
    if (!this.activeChat?.listing_id) {
      console.warn('Cannot perform action: No activeChat or listing_id');
      return;
    }

    this.orderService.getOrders().subscribe({
      next: (orders: any) => {
        const orderList = Array.isArray(orders) ? orders : (orders.results || []);
        const matching = orderList.find((o: any) => {
          const lId = typeof o.listing === 'object' ? o.listing?.id : o.listing;
          return String(lId) === String(this.activeChat.listing_id);
        });
        if (matching && matching.id) {
          if (this.activeChat) {
            this.activeChat.order_id = matching.id;
            this.activeChat.order_status = matching.status;
          }
          callback(matching.id);
        } else {
          console.error('No matching order found for listing', this.activeChat.listing_id);
        }
      },
      error: (err) => console.error('Failed to fetch orders', err)
    });
  }

  async handleAcceptMeetup() {
    // Same time/place form as accepting from the orders list; accepting here
    // used to skip it and left the meetup with no time or place.
    const details = await this.meetupDetails.ask(this.activeChat?.listing_title || '');
    if (!details) return;
    this.getOrFetchOrderId((orderId) => {
      this.orderService.updateOrderStatus(orderId, 'accepted', undefined, details.time || undefined, details.location || undefined).subscribe({
        next: (order) => {
          this.ga.trackOrderStep(orderId, 'accepted');
          if (this.activeChat) {
            this.activeChat.order_status = 'accepted';
            this.applyMeetupDetails(this.activeChat, order);
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.toast.error(this.orderActionError(err));
          console.error('Failed to accept meetup order', err);
        }
      });
    });
  }

  /** The seller changes the agreed time/place, from the card showing them. */
  async handleEditMeetup() {
    const chat = this.activeChat;
    if (!chat?.order_id) return;
    const details = await this.meetupDetails.ask(chat.listing_title || '', {
      time: chat.order_meetup_time || '',
      location: chat.order_meetup_location || '',
    });
    if (!details) return;
    this.orderService.updateMeetupDetails(chat.order_id, details.time, details.location).subscribe({
      next: (order) => {
        this.applyMeetupDetails(chat, order);
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.toast.error(this.orderActionError(err));
      }
    });
  }

  /**
   * The toast for a meetup action the server refused. Only a reason the
   * locale can render goes after "Action failed:" — `detail` is DRF's English
   * prose, `status` is an untranslated code array, and `err.message` is
   * Angular's "Http failure response for …" — none of which a buyer can act on.
   */
  private orderActionError(err: any): string {
    const msg = translateApiError(err, this.i18n);
    return msg ? this.i18n.t('msg.orderActionFailed', { msg }) : this.i18n.t('msg.orderActionRetry');
  }

  private applyMeetupDetails(chat: any, order: any) {
    chat.order_meetup_time = order?.meetup_time || null;
    chat.order_meetup_location = order?.meetup_location || '';
  }

  /**
   * The meetup card that shows the agreed time/place: the latest accept (or
   * details-updated) card, while the order it belongs to is still live.
   * Earlier cards are history and would show details that no longer apply.
   */
  showsMeetupDetails(msg: any): boolean {
    if (!this.activeChat || !MEETUP_DETAIL_STATUSES.includes(this.activeChat.order_status)) return false;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (isMeetupDetailsMessage(this.messages[i].body)) return this.messages[i] === msg;
    }
    return false;
  }

  /** The seller may still change the details until the handover. */
  canEditMeetup(msg: any): boolean {
    return this.activeChat?.other_party_role === 'buyer'
      && this.activeChat.order_status === 'accepted'
      && this.showsMeetupDetails(msg);
  }

  handleDeclineMeetup() {
    this.getOrFetchOrderId((orderId) => {
      this.orderService.updateOrderStatus(orderId, 'cancelled', 'seller_declined').subscribe({
        next: () => {
          this.ga.trackCancelOrder(orderId, 'seller_declined');
          if (this.activeChat) this.activeChat.order_status = 'cancelled';
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.toast.error(this.orderActionError(err));
          console.error('Failed to decline meetup order', err);
        }
      });
    });
  }

  handleCancelMeetup() {
    this.getOrFetchOrderId((orderId) => {
      this.orderService.updateOrderStatus(orderId, 'cancelled', 'buyer_cancelled').subscribe({
        next: () => {
          this.ga.trackCancelOrder(orderId, 'buyer_cancelled');
          if (this.activeChat) this.activeChat.order_status = 'cancelled';
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.toast.error(this.orderActionError(err));
          console.error('Failed to cancel meetup order', err);
        }
      });
    });
  }

  // Initialized in ngOnInit() so i18n.t() calls don't re-fire during
  // *ngFor change detection (causes infinite loop/freeze).
  /** The other participant — whoever in this conversation isn't the viewer. */
  get reportedPartyId(): string | number {
    const userId = this.authStore.user()?.id;
    return String(userId) === String(this.activeChat?.buyer_id)
      ? this.activeChat?.seller_id
      : this.activeChat?.buyer_id;
  }

  async deleteConversation(chat: any) {
    const confirmed = await this.confirms.askDanger(this.i18n.t('msg.confirmDeleteConversation'), {
      confirmLabel: this.i18n.t('common.delete'),
    });
    if (!confirmed) return;
    // Only this browser knows of a pending chat.
    const removal = isPendingChat(chat)
      ? of({ status: 'deleted' }).pipe(tap(() => this.pendingChats.remove(chat.id)))
      : this.messageService.deleteConversation(chat.id);
    removal.subscribe({
      next: () => {
        // Remove from sidebar
        this.clearDraft(chat.id);
        this.chats = this.chats.filter(c => c.id !== chat.id);
        if (this.activeChat?.id === chat.id) {
          this.activeChat = null;
          this.messages = [];
          this.newMessage = '';
          // Otherwise a refresh would try to reopen the conversation just
          // deleted, and Back would return to it.
          this.clearChatParam();
        }
        this.cdr.markForCheck();
      }
    });
  }

  onDraftChange(text: string) {
    if (this.activeChat?.id) {
      this.saveDraft(this.activeChat.id, text);
    }
  }

  private saveDraft(conversationId: string | number, text: string): void {
    if (!conversationId || typeof window === 'undefined' || !window.sessionStorage) return;
    try {
      const key = `${this.DRAFT_STORAGE_PREFIX}${conversationId}`;
      const capped = (text || '').slice(0, this.MAX_DRAFT_LENGTH);
      if (capped.length > 0) {
        window.sessionStorage.setItem(key, capped);
      } else {
        window.sessionStorage.removeItem(key);
      }
    } catch {
      // Storage unavailable or quota exceeded — fail gracefully without throwing
    }
  }

  private loadDraft(conversationId: string | number): string {
    if (!conversationId || typeof window === 'undefined' || !window.sessionStorage) return '';
    try {
      const key = `${this.DRAFT_STORAGE_PREFIX}${conversationId}`;
      return window.sessionStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  private clearDraft(conversationId: string | number): void {
    if (!conversationId || typeof window === 'undefined' || !window.sessionStorage) return;
    try {
      const key = `${this.DRAFT_STORAGE_PREFIX}${conversationId}`;
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage unavailable — ignore
    }
  }
}

