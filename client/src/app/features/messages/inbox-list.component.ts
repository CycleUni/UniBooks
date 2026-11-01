import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService, TPipe } from '../../core/i18n.service';
import { intlLocale } from '../../core/i18n';
import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { UiRoleBadge } from '../../shared/ui/role-badge.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { injectIsPhone } from '../../core/viewport';
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
  imports: [CommonModule, TPipe, UiRoleBadge, UiSkeleton, BookCoverPipe],
  // Checked with its parent, not only on a new `chats` array. The Messages
  // page updates rows in place — a live message's preview and time, the
  // unread dot — and under OnPush (Angular's default) those never showed
  // until a reload: the row already at the top gets no new array.
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="sidebar-header">
      <h3>{{ 'msg.inbox' | t }}</h3>
      <!-- Phones have no hover for the row's × button; Edit selects rows to
           delete instead, several at once. -->
      <button class="icon-btn edit-btn" type="button" *ngIf="isPhone() && (editing || chats.length > 0)"
              [attr.aria-label]="(editing ? 'common.cancel' : 'common.edit') | t"
              [title]="(editing ? 'common.cancel' : 'common.edit') | t"
              (click)="setEditing(!editing)">
        <svg *ngIf="!editing" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 20h9"/>
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
        </svg>
        <svg *ngIf="editing" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="chat-list" [class.editing]="editing">
      <ui-skeleton *ngIf="loading" variant="chat-list" [count]="6"></ui-skeleton>
      <div
        class="chat-item"
        *ngFor="let chat of chats"
        [class.active]="activeChatId === chat.id"
        [class.role-buyer]="chat.other_party_role === 'buyer'"
        [class.role-seller]="chat.other_party_role === 'seller'"
        [class.unread]="chat._hubUnread"
        [class.selected]="editing && selectedIds.has(chat.id)"
        [attr.role]="editing ? 'checkbox' : null"
        [attr.aria-checked]="editing ? selectedIds.has(chat.id) : null"
        [attr.tabindex]="editing ? 0 : null"
        (click)="editing ? toggle(chat) : select.emit(chat)"
        (keydown.enter)="editing && toggle(chat, $event)"
        (keydown.space)="editing && toggle(chat, $event)"
      >
        <span class="select-marker" *ngIf="editing" aria-hidden="true"></span>
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
              <button class="chat-delete-btn" type="button" *ngIf="!editing" [title]="'msg.deleteConversation' | t"
                      (click)="$event.stopPropagation(); remove.emit(chat)">×</button>
            </div>
          </div>
          <div class="chat-subject">{{ 'msg.bookPrefix' | t:{title: chat.listing_title} }}<span *ngIf="chat.listing_deleted"> · {{ 'common.listingDeleted' | t }}</span></div>
          <div class="chat-preview" [class.pending]="chat.pending">{{ chat.pending ? ('msg.pendingPreview' | t) : formatPreview(chat.latest_message) }}</div>
        </div>
      </div>
    </div>
    <div class="edit-bar" *ngIf="editing">
      <button class="icon-btn select-all-btn" type="button" (click)="toggleAll()" [disabled]="busy"
              [attr.aria-pressed]="allSelected"
              [attr.aria-label]="(allSelected ? 'msg.deselectAll' : 'msg.selectAll') | t"
              [title]="(allSelected ? 'msg.deselectAll' : 'msg.selectAll') | t">
        <!-- Ticked boxes stacked: select all; filled once they all are. -->
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="7" y="7" width="14" height="14" rx="2" [attr.fill]="allSelected ? 'currentColor' : 'none'"/>
          <path d="M3 17V5a2 2 0 0 1 2-2h12"/>
          <polyline points="10.5 14 13 16.5 17.5 11.5" [attr.stroke]="allSelected ? 'var(--paper)' : 'currentColor'"/>
        </svg>
      </button>
      <span class="selected-count" aria-live="polite">{{ 'msg.selectedCount' | t:{count: selectedIds.size} }}</span>
      <button class="icon-btn delete-btn" type="button" [disabled]="busy || selectedIds.size === 0" (click)="removeSelected()"
              [attr.aria-label]="'msg.deleteSelected' | t:{count: selectedIds.size}"
              [title]="'msg.deleteSelected' | t:{count: selectedIds.size}">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </button>
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 16px;
      border-bottom: 1px solid var(--line);
    }
    .icon-btn {
      display: inline-grid;
      place-content: center;
      width: var(--tap-min);
      height: var(--tap-min);
      padding: 0;
      background: none;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--accent);
      cursor: pointer;
    }
    .icon-btn:disabled {
      color: var(--muted);
      cursor: not-allowed;
    }
    .edit-btn {
      margin: -12px -10px;
    }
    .delete-btn:not(:disabled) {
      color: var(--danger);
    }
    .selected-count {
      font-size: var(--text-sm);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    /* In place of the bottom tabs, which the Messages page hides while
       editing; styled as ui-action-bar on phones. The list leaves room. */
    .edit-bar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 12px calc(6px + env(safe-area-inset-bottom, 0px));
      background: var(--paper);
      border-top: 1px solid var(--line);
    }
    .chat-list.editing {
      padding-bottom: calc(57px + env(safe-area-inset-bottom, 0px));
    }
    /* Same recipe as ui-checkbox, drawn here so the whole row is the target. */
    .select-marker {
      flex-shrink: 0;
      align-self: center;
      width: 18px;
      height: 18px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-xs);
      background-color: var(--paper);
      box-sizing: border-box;
      display: grid;
      place-content: center;
    }
    .select-marker::before {
      content: "";
      width: 10px;
      height: 10px;
      background-color: var(--btn-primary-ink);
      clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
      transform: scale(0);
      transition: transform var(--motion-fast) ease-in-out;
    }
    .chat-item.selected .select-marker {
      background-color: var(--accent);
      border-color: var(--accent);
    }
    .chat-item.selected .select-marker::before {
      transform: scale(1);
    }
    @media (prefers-reduced-motion: reduce) {
      .select-marker::before { transition: none; }
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
export class MessagesInboxList implements OnChanges, OnDestroy {
  @Input() chats: any[] = [];
  @Input() activeChatId: string | null = null;
  /** The conversations are still loading: placeholder rows show. */
  @Input() loading = false;
  @Output() select = new EventEmitter<any>();
  @Output() remove = new EventEmitter<any>();
  /** A delete of the selected conversations is on its way. */
  @Input() busy = false;
  /** The conversations ticked in edit mode, to delete. */
  @Output() removeMany = new EventEmitter<any[]>();
  @Output() editingChange = new EventEmitter<boolean>();

  private i18n = inject(I18nService);
  readonly isPhone = injectIsPhone();

  editing = false;
  selectedIds = new Set<string>();

  constructor() {
    // Edit mode is the phone's: leaving that layout (a rotated tablet, a
    // widened window) brings the hover × buttons back instead.
    effect(() => {
      if (!this.isPhone()) untracked(() => this.setEditing(false));
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (!changes['chats'] || !this.editing) return;
    // Deleted conversations leave the selection; once every selected one
    // has gone, the delete is done and so is editing. One that failed to
    // delete stays ticked for another try.
    const ids = new Set(this.chats.map((c) => c.id));
    const before = this.selectedIds.size;
    this.selectedIds = new Set([...this.selectedIds].filter((id) => ids.has(id)));
    if (before > 0 && this.selectedIds.size === 0) this.setEditing(false);
    else if (this.chats.length === 0) this.setEditing(false);
  }

  ngOnDestroy() {
    // Gone with edit mode still on (deleting the last conversations removes
    // the whole list): give the bottom tabs back.
    if (this.editing) this.editingChange.emit(false);
  }

  get allSelected(): boolean {
    return this.chats.length > 0 && this.selectedIds.size === this.chats.length;
  }

  setEditing(editing: boolean) {
    if (this.editing === editing) return;
    this.editing = editing;
    this.selectedIds = new Set();
    this.editingChange.emit(editing);
  }

  toggle(chat: any, event?: Event) {
    // Space would otherwise scroll the list.
    event?.preventDefault();
    const next = new Set(this.selectedIds);
    if (next.has(chat.id)) next.delete(chat.id);
    else next.add(chat.id);
    this.selectedIds = next;
  }

  toggleAll() {
    this.selectedIds = this.allSelected ? new Set() : new Set(this.chats.map((c) => c.id));
  }

  removeSelected() {
    const chats = this.chats.filter((c) => this.selectedIds.has(c.id));
    if (chats.length) this.removeMany.emit(chats);
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
