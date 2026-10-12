import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiRoleBadge } from '../../shared/ui/role-badge.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { formatInboxTime } from './message-formatting.util';

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
  imports: [CommonModule, TPipe, UiRoleBadge, UiSkeleton],
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
      <div
        class="chat-item"
        *ngFor="let chat of chats"
        [class.active]="activeChatId === chat.id"
        [class.role-buyer]="chat.other_party_role === 'buyer'"
        [class.role-seller]="chat.other_party_role === 'seller'"
        [class.unread]="chat._hubUnread"
        (click)="select.emit(chat)"
      >
        <img *ngIf="chat.listing_photo" [src]="chat.listing_photo" [attr.alt]="chat.listing_title || ('common.bookCover' | t)" class="chat-thumb">
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
              <button class="chat-delete-btn" type="button" [title]="'msg.deleteConversation' | t"
                      (click)="$event.stopPropagation(); remove.emit(chat)">×</button>
            </div>
          </div>
          <div class="chat-subject">{{ 'msg.bookPrefix' | t:{title: chat.listing_title} }}<span *ngIf="chat.listing_deleted"> · {{ 'common.listingDeleted' | t }}</span></div>
          <div class="chat-preview" [class.pending]="chat.pending">{{ chat.pending ? ('msg.pendingPreview' | t) : formatPreview(chat.latest_message) }}</div>
        </div>
      </div>
    </div>
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
    .chat-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      border-left: 3px solid transparent;
      cursor: pointer;
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
export class MessagesInboxList {
  @Input() chats: any[] = [];
  @Input() activeChatId: string | null = null;
  /** The conversations are still loading: placeholder rows show. */
  @Input() loading = false;
  @Output() select = new EventEmitter<any>();
  @Output() remove = new EventEmitter<any>();

  private i18n = inject(I18nService);

  /**
   * When the conversation last had activity. `updated_at` is the time of the
   * newest message: Django moves it when it mirrors a message into
   * `latest_message_body`, and the Messages page moves it locally for
   * messages sent or received while it is open.
   */
  formatTime(updatedAt: string): string {
    return formatInboxTime(updatedAt, this.i18n.lang() === 'en' ? 'en-US' : 'zh-TW');
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
