import {
  Component,
  Input,
  Output,
  EventEmitter,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe, I18nService } from '../../core/i18n.service';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { UiButton } from '../../shared/ui/button.component';
import { ConfirmService } from '../../core/services/confirm.service';

export interface ChatListingItem {
  ref: string;
  id: string | null;
  title: string;
  isbn: string;
  price: number | null;
  status: string | null;
  cover_url: string;
  is_available: boolean;
}

@Component({
  selector: 'app-chat-listings-header',
  standalone: true,
  imports: [CommonModule, TPipe, PricePipe, BookCoverPipe, UiButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chat-listings-banner">
      <div class="listings-strip" role="region" [attr.aria-label]="'msg.pickerTitle' | t">
        <div
          *ngFor="let item of listings; trackBy: trackByRef"
          class="listing-chip"
          [class.unavailable]="!item.is_available"
        >
          <button
            type="button"
            class="chip-content"
            (click)="selectListing(item)"
            [disabled]="!item.is_available"
            [title]="('msg.viewListing' | t) + ': ' + item.title"
            [attr.aria-label]="('msg.viewListing' | t) + ': ' + item.title"
          >
            <img
              *ngIf="item.cover_url"
              [src]="item.cover_url | bookCover"
              [attr.alt]="item.title || ('common.bookCover' | t)"
              class="chip-thumb"
            />
            <span class="placeholder-thumb" *ngIf="!item.cover_url"></span>
            <div class="chip-info">
              <span class="chip-title">{{ item.title }}</span>
              <span class="chip-meta">
                <span class="chip-price" *ngIf="item.price !== null">{{ item.price | price }}</span>
                <span class="badge danger" *ngIf="!item.is_available">
                  {{ 'common.listingDeleted' | t }}
                </span>
              </span>
            </div>
          </button>

          <button
            *ngIf="isBuyer && listings.length > 1"
            type="button"
            class="chip-remove-btn"
            [title]="'msg.confirmRemoveListing' | t"
            [attr.aria-label]="('msg.removeListing' | t) + ': ' + item.title"
            (click)="onRemoveClick(item, $event)"
          >
            ×
          </button>
        </div>

        <button
          *ngIf="isBuyer"
          type="button"
          class="add-book-chip"
          (click)="openPicker.emit()"
        >
          <span class="add-icon" aria-hidden="true">+</span>
          <span>{{ 'msg.addOtherBooks' | t }}</span>
        </button>
      </div>

      <!-- =========================================================================
           EXTENSION POINT: Order Placement Seam
           The next task will add an ordering button / checkout trigger here with
           direct access to the conversation's active listings.
           ========================================================================= -->
      <div class="header-actions" *ngIf="hasOrder">
        <ui-button variant="ghost" (onClick)="viewOrder.emit()">
          {{ 'msg.viewOrder' | t }}
        </ui-button>
      </div>
    </div>
  `,
  styles: [`
    .chat-listings-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--line);
      min-width: 0;
    }

    .listings-strip {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow-x: auto;
      scrollbar-width: thin;
      -webkit-overflow-scrolling: touch;
      flex: 1;
      min-width: 0;
      padding: 2px 0;
    }

    .listings-strip::-webkit-scrollbar {
      height: 4px;
    }

    .listings-strip::-webkit-scrollbar-thumb {
      background: var(--line-strong);
      border-radius: var(--radius-sm);
    }

    .listing-chip {
      position: relative;
      display: flex;
      align-items: center;
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-md);
      padding: 4px 8px;
      flex-shrink: 0;
      max-width: 220px;
      transition: background var(--motion-fast);
    }

    .listing-chip.unavailable {
      opacity: 0.7;
    }

    .chip-content {
      display: flex;
      align-items: center;
      gap: 8px;
      background: transparent;
      border: none;
      padding: 0;
      cursor: pointer;
      text-align: left;
      font: inherit;
      color: inherit;
      min-width: 0;
    }

    .chip-thumb {
      width: 28px;
      height: 38px;
      object-fit: cover;
      border-radius: var(--radius-xs);
      flex-shrink: 0;
      background: var(--bg-surface);
    }

    .placeholder-thumb {
      width: 28px;
      height: 38px;
      border-radius: var(--radius-xs);
      background: var(--line);
      flex-shrink: 0;
    }

    .chip-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      max-width: 130px;
    }

    .chip-title {
      font-size: var(--text-xs);
      font-weight: 600;
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chip-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: var(--text-2xs, 11px);
    }

    .chip-price {
      font-weight: 600;
      color: var(--brand, var(--ink));
    }

    .chip-remove-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      margin-left: 6px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--muted);
      border-radius: 50%;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      transition: color var(--motion-fast), background var(--motion-fast);
      flex-shrink: 0;
    }

    .chip-remove-btn:hover {
      background: var(--danger-light);
      color: var(--danger);
    }

    .add-book-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: var(--bg-surface);
      border: 1px dashed var(--line-strong);
      border-radius: var(--radius-md);
      color: var(--ink);
      font-size: var(--text-xs);
      font-weight: 500;
      cursor: pointer;
      flex-shrink: 0;
      white-space: nowrap;
      min-height: 44px;
      transition: border-color var(--motion-fast), background var(--motion-fast);
    }

    .add-book-chip:hover {
      border-color: var(--ink);
      background: var(--bg);
    }

    .add-icon {
      font-size: 16px;
      font-weight: 700;
      line-height: 1;
    }

    .header-actions {
      flex-shrink: 0;
    }

    .badge.danger {
      color: var(--danger);
      font-size: var(--text-2xs, 10px);
    }
  `],
})
export class ChatListingsHeaderComponent {
  private confirms = inject(ConfirmService);
  private i18n = inject(I18nService);

  @Input() listings: ChatListingItem[] = [];
  @Input() isBuyer = false;
  @Input() hasOrder = false;

  @Output() openPicker = new EventEmitter<void>();
  @Output() removeListing = new EventEmitter<ChatListingItem>();
  @Output() goListing = new EventEmitter<string>();
  @Output() viewOrder = new EventEmitter<void>();

  trackByRef(_: number, item: ChatListingItem): string {
    return item.ref;
  }

  selectListing(item: ChatListingItem): void {
    if (item.ref) {
      this.goListing.emit(item.ref);
    }
  }

  async onRemoveClick(item: ChatListingItem, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const confirmed = await this.confirms.askDanger(
      this.i18n.t('msg.confirmRemoveListing'),
      { confirmLabel: this.i18n.t('msg.removeListing') }
    );
    if (confirmed) {
      this.removeListing.emit(item);
    }
  }

  // =========================================================================
  // EXTENSION POINT: Method hook for future order placement
  // The next task will invoke order placement for the current conversation listings.
  // Uses 'msg.buyNow' for the action button label.
  // =========================================================================
  getSelectedListings(): ChatListingItem[] {
    return this.listings.filter((l) => l.is_available);
  }
}
