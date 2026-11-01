import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnDestroy, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService, TPipe } from '../../core/i18n.service';
import { intlLocale } from '../../core/i18n';
import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { UiRoleBadge } from '../../shared/ui/role-badge.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiBottomSheet } from '../../shared/ui/bottom-sheet.component';
import { injectIsPhone } from '../../core/viewport';
import { formatInboxTime } from './message-formatting.util';

/** How far a swipe opens a row: the Delete button's width. */
const SWIPE_OPEN_PX = 80;
/** Held this long without moving, a touch opens the row's menu. */
export const LONG_PRESS_MS = 500;
/** Movement within this is still a tap or a press, not a drag. */
const TOUCH_SLOP_PX = 8;

/**
 * Conversation list in the Messages sidebar. Presentational: it renders the
 * conversations it is given and reports clicks; all loading, selection and
 * deletion logic stays in the Messages page.
 *
 * Extracted from that page, which had grown past the `anyComponentStyle`
 * build budget — see also UiImageLightbox and UiReportModal. The `.sidebar`
 * wrapper (and its responsive rules) stays with the parent, since that is
 * layout coordination between the sidebar and the chat area.
 */
@Component({
  selector: 'messages-inbox-list',
  standalone: true,
  imports: [CommonModule, TPipe, UiRoleBadge, UiSkeleton, UiBottomSheet, BookCoverPipe],
  // Checked with its parent, not only on a new `chats` array. The Messages
  // page updates rows in place — a live message's preview and time, the
  // unread dot — and under OnPush (Angular's default) those never showed
  // until a reload: the row already at the top gets no new array.
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="sidebar-header">
      <h3>{{ 'msg.inbox' | t }}</h3>
    </div>
    <div class="chat-list">
      <ui-skeleton *ngIf="loading" variant="chat-list" [count]="6"></ui-skeleton>
      <!-- On phones, which have no hover for the × button: swipe a row left
           to show Delete, or long-press it for a menu. -->
      <div class="chat-row" *ngFor="let chat of chats">
      <button class="swipe-delete" type="button" *ngIf="isPhone() && offsetFor(chat) < 0"
              tabindex="-1" aria-hidden="true" (click)="swipeDelete(chat)">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        <span>{{ 'common.delete' | t }}</span>
      </button>
      <div
        class="chat-item"
        [class.active]="activeChatId === chat.id"
        [class.role-buyer]="chat.other_party_role === 'buyer'"
        [class.role-seller]="chat.other_party_role === 'seller'"
        [class.unread]="chat._hubUnread"
        [class.dragging]="dragId === chat.id"
        [style.transform]="offsetFor(chat) ? 'translateX(' + offsetFor(chat) + 'px)' : null"
        (pointerdown)="onPointerDown($event, chat)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp()"
        (pointercancel)="onPointerCancel()"
        (contextmenu)="isPhone() && $event.preventDefault()"
        (click)="onRowClick(chat)"
      >
        <img *ngIf="chat.listing_photo" [src]="chat.listing_photo | bookCover" [attr.alt]="chat.listing_title || ('common.bookCover' | t)" class="chat-thumb">
        <div class="chat-thumb placeholder-thumb" *ngIf="!chat.listing_photo"></div>
        <div class="chat-body">
          <div class="chat-meta">
            <!-- The school rides along because display names are not unique:
                 two chats with two different 周恭煥 looked identical. -->
            <span class="chat-partner">{{ chat.other_party }}<span class="chat-partner-school" *ngIf="chat.other_party_school_name"> · {{ chat.other_party_school_name }}</span></span>
            <div class="chat-meta-right">
              <ui-role-badge [role]="chat.other_party_role"></ui-role-badge>
              <span class="unread-dot" *ngIf="chat._hubUnread" role="img" [attr.aria-label]="'msg.unread' | t"></span>
              <time class="chat-time" *ngIf="chat.updated_at" [attr.datetime]="chat.updated_at">{{ formatTime(chat.updated_at) }}</time>
              <!-- On phones, kept for keyboards and screen readers, which
                   cannot swipe or long-press: hidden from sight only. -->
              <button class="chat-delete-btn" type="button" [class.sr-only]="isPhone()"
                      [title]="'msg.deleteConversation' | t" [attr.aria-label]="'msg.deleteConversation' | t"
                      (click)="$event.stopPropagation(); remove.emit(chat)">×</button>
            </div>
          </div>
          <div class="chat-subject">{{ 'msg.bookPrefix' | t:{title: chat.listing_title} }}<span *ngIf="chat.listing_deleted"> · {{ 'common.listingDeleted' | t }}</span></div>
          <div class="chat-preview" [class.pending]="chat.pending">{{ chat.pending ? ('msg.pendingPreview' | t) : formatPreview(chat.latest_message) }}</div>
        </div>
      </div>
      </div>
    </div>
    <ui-bottom-sheet *ngIf="menuChat" [title]="menuChat.other_party" (closed)="menuChat = null">
      <button class="sheet-action danger" type="button" (click)="deleteFromMenu()">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        {{ 'msg.deleteConversation' | t }}
      </button>
    </ui-bottom-sheet>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .sidebar-header {
      padding: 16px;
      border-bottom: 1px solid var(--line);
    }
    .sidebar-header h3 {
      margin: 0;
      font-size: var(--text-lg);
    }
    .chat-list {
      flex: 1;
      overflow-y: auto;
    }
    .chat-row {
      position: relative;
      overflow: hidden;
    }
    .chat-item {
      position: relative;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      border-left: 3px solid transparent;
      cursor: pointer;
      /* Opaque, so the swipe's Delete underneath only shows as the row moves. */
      background-color: var(--paper-warm);
      /* Vertical scrolling stays the browser's; a horizontal drag is a swipe. */
      touch-action: pan-y;
      -webkit-touch-callout: none;
      user-select: none;
      transition: transform var(--motion-fast) ease-out;
    }
    .chat-item.dragging {
      transition: none;
    }
    .swipe-delete {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 80px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      border: none;
      background-color: var(--danger);
      color: var(--paper);
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
    }
    .sheet-action {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      min-height: var(--tap-min);
      padding: 0 4px;
      border: none;
      background: none;
      color: var(--ink);
      font: inherit;
      cursor: pointer;
    }
    .sheet-action.danger {
      color: var(--danger);
    }
    .chat-delete-btn.sr-only {
      display: inline-block;
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      .chat-item { transition: none; }
    }
    .chat-item:hover {
      background-color: var(--paper);
    }
    .chat-item.active {
      background-color: var(--paper);
      border-left-color: var(--accent);
    }
    .chat-item.active.role-buyer {
      border-left-color: var(--flag);
    }
    .chat-item.active.role-seller {
      border-left-color: var(--accent);
    }
    .chat-thumb {
      width: 40px;
      height: 52px;
      flex-shrink: 0;
      object-fit: cover;
      border-radius: var(--radius-sm);
      background-color: var(--line);
    }
    .chat-body {
      flex: 1;
      min-width: 0;
    }
    .chat-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }
    .chat-partner {
      font-weight: 700;
      color: var(--ink);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-partner-school {
      font-weight: 400;
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .chat-meta-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .unread-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--accent);
      flex-shrink: 0;
    }
    .chat-time {
      font-size: var(--text-sm);
      color: var(--muted);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .chat-item.unread .chat-time {
      color: var(--accent);
      font-weight: 600;
    }
    .chat-delete-btn {
      display: none;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--muted);
      font-size: var(--text-md);
      line-height: 1;
      padding: 0 2px;
      flex-shrink: 0;
    }
    .chat-delete-btn:hover {
      color: var(--flag);
    }
    .chat-item:hover .chat-delete-btn {
      display: inline-block;
    }
    .chat-subject {
      font-size: var(--text-sm);
      color: var(--accent);
      margin-bottom: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .chat-preview {
      font-size: var(--text-base);
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* The dot alone is 8px of colour that is easy to miss at a glance down a
       long list; darkening the preview text is what most inboxes do too. */
    /* Not sent yet: only this browser has the chat (PendingChatStore). */
    .chat-preview.pending { font-style: italic; }
    .chat-item.unread .chat-preview {
      color: var(--ink);
      font-weight: 600;
    }
  `]
})
export class MessagesInboxList implements OnDestroy {
  @Input() chats: any[] = [];
  @Input() activeChatId: string | null = null;
  /** The conversations are still loading: placeholder rows show. */
  @Input() loading = false;
  @Output() select = new EventEmitter<any>();
  @Output() remove = new EventEmitter<any>();

  private i18n = inject(I18nService);
  readonly isPhone = injectIsPhone();

  /** The row a swipe left has opened to its Delete button; one at a time. */
  openId: string | null = null;
  /** The row under a finger mid-swipe, and where it is. */
  dragId: string | null = null;
  dragX = 0;
  /** The conversation whose long-press menu is open. */
  menuChat: any = null;
  private gesture: { id: string; x: number; y: number; from: number; axis: 'x' | 'y' | null; timer: ReturnType<typeof setTimeout> } | null = null;
  /** A swipe or a long press just ended: the click that follows is not a tap. */
  private swallowClick = false;

  ngOnDestroy() {
    if (this.gesture) clearTimeout(this.gesture.timer);
  }

  offsetFor(chat: any): number {
    if (this.dragId === chat.id) return this.dragX;
    return this.openId === chat.id ? -SWIPE_OPEN_PX : 0;
  }

  onPointerDown(event: PointerEvent, chat: any) {
    this.swallowClick = false;
    if (!this.isPhone() || event.pointerType === 'mouse') return;
    if (this.gesture) clearTimeout(this.gesture.timer);
    this.gesture = {
      id: chat.id,
      x: event.clientX,
      y: event.clientY,
      from: this.offsetFor(chat),
      axis: null,
      timer: setTimeout(() => this.longPress(chat), LONG_PRESS_MS),
    };
  }

  onPointerMove(event: PointerEvent) {
    const g = this.gesture;
    if (!g) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.axis) {
      if (Math.abs(dx) < TOUCH_SLOP_PX && Math.abs(dy) < TOUCH_SLOP_PX) return;
      clearTimeout(g.timer);
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (g.axis === 'x') {
        // Another row's open Delete closes as this one moves.
        if (this.openId !== g.id) this.openId = null;
        (event.target as Element).setPointerCapture?.(event.pointerId);
      }
    }
    if (g.axis !== 'x') return;
    this.dragId = g.id;
    this.dragX = Math.max(-SWIPE_OPEN_PX, Math.min(0, g.from + dx));
  }

  onPointerUp() {
    const g = this.gesture;
    if (!g) return;
    clearTimeout(g.timer);
    if (g.axis === 'x') {
      this.openId = this.dragX < -SWIPE_OPEN_PX / 2 ? g.id : null;
      this.dragId = null;
      this.swallowClick = true;
    }
    this.gesture = null;
  }

  onPointerCancel() {
    // The browser took the touch over to scroll the list.
    if (this.gesture) clearTimeout(this.gesture.timer);
    this.gesture = null;
    this.dragId = null;
  }

  onRowClick(chat: any) {
    if (this.swallowClick) {
      this.swallowClick = false;
      return;
    }
    // A tap anywhere on the list first closes an open Delete.
    if (this.openId) {
      this.openId = null;
      return;
    }
    this.select.emit(chat);
  }

  swipeDelete(chat: any) {
    this.openId = null;
    this.remove.emit(chat);
  }

  deleteFromMenu() {
    const chat = this.menuChat;
    this.menuChat = null;
    if (chat) this.remove.emit(chat);
  }

  private longPress(chat: any) {
    if (!this.gesture || this.gesture.axis) return;
    this.gesture = null;
    this.swallowClick = true;
    this.openId = null;
    this.menuChat = chat;
    navigator.vibrate?.(10);
  }

  /**
   * When the conversation last had activity. `updated_at` is the time of the
   * newest message: the API moves it when it mirrors a message into
   * `latest_message_body`, and the Messages page moves it locally for
   * messages sent or received while it is open.
   */
  formatTime(updatedAt: string): string {
    return formatInboxTime(updatedAt, intlLocale(this.i18n.lang()));
  }

  /**
   * Resolves a `[SYSTEM:<i18nKey>]` preview (order notifications, image
   * placeholders) to text in the viewer's language. Previews are written
   * server-side and shared by both participants, so they carry a key rather
   * than pre-translated text — see IMAGE_PREVIEW_TOKEN.
   */
  formatPreview(body: string): string {
    // Back-compat: previews written before image placeholders became an i18n
    // token still hold a literal Chinese string.
    if (body === '[圖片]') return this.i18n.t('msg.imagePlaceholder') || body;
    if (!body || !body.startsWith('[SYSTEM:')) return body;
    const match = body.match(/\[SYSTEM:([^\]]+)\]/);
    if (!match) return body;
    return this.i18n.t(match[1]) || body;
  }
}
