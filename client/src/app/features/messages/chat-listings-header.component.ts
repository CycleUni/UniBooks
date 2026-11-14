import {
  Component,
  Input,
  Output,
  EventEmitter,
  inject,
  ChangeDetectionStrategy,
  OnChanges,
  SimpleChanges,
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
          <label
            class="chip-checkbox-label"
            *ngIf="isBuyer && item.is_available"
            (click)="$event.stopPropagation()"
          >
            <input
              type="checkbox"
              class="chip-checkbox"
              [checked]="selectedRefs.has(item.ref)"
              (change)="toggleSelection(item, $event)"
              [attr.aria-label]="item.title"
            />
          </label>

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
                  {{ getUnavailableReasonKey(item) | t }}
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

      <div class="header-actions">
        <ui-button
          *ngIf="isBuyer && hasAvailableListings"
          size="sm"
          [disabled]="selectedCount === 0"
          (onClick)="onOrderClick()"
        >
          {{ 'msg.orderAction' | t:{ count: selectedCount, total: (selectedTotal | price) } }}
        </ui-button>
        <ui-button *ngIf="hasOrder" variant="ghost" size="sm" (onClick)="viewOrder.emit()">
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
      max-width: 240px;
      transition: background var(--motion-fast);
    }

    .listing-chip.unavailable {
      opacity: 0.7;
    }

    .chip-checkbox-label {
      display: flex;
      align-items: center;
      margin-right: 6px;
      cursor: pointer;
    }

    .chip-checkbox {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
      cursor: pointer;
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
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .badge.danger {
      color: var(--danger);
      font-size: var(--text-2xs, 10px);
    }
  `],
})
export class ChatListingsHeaderComponent implements OnChanges {
  private confirms = inject(ConfirmService);
  private i18n = inject(I18nService);

  private _listings: ChatListingItem[] = [];

  @Input()
  set listings(val: ChatListingItem[]) {
    this._listings = val || [];
    this.syncSelectedRefs();
  }
  get listings(): ChatListingItem[] {
    return this._listings;
  }

  @Input() isBuyer = false;
  @Input() hasOrder = false;

  @Output() openPicker = new EventEmitter<void>();
  @Output() removeListing = new EventEmitter<ChatListingItem>();
  @Output() goListing = new EventEmitter<string>();
  @Output() viewOrder = new EventEmitter<void>();
  @Output() startOrder = new EventEmitter<string[]>();

  selectedRefs = new Set<string>();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['listings']) {
      this.syncSelectedRefs();
    }
  }

  private syncSelectedRefs(): void {
    const availableRefs = new Set(this._listings.filter((l) => l.is_available).map((l) => l.ref));
    if (this.selectedRefs.size === 0) {
      this.selectedRefs = new Set(availableRefs);
    } else {
      const next = new Set<string>();
      for (const ref of this.selectedRefs) {
        if (availableRefs.has(ref)) next.add(ref);
      }
      for (const l of this._listings) {
        if (l.is_available && !this.selectedRefs.has(l.ref)) {
          next.add(l.ref);
        }
      }
      this.selectedRefs = next;
    }
  }

  trackByRef(_: number, item: ChatListingItem): string {
    return item.ref;
  }

  selectListing(item: ChatListingItem): void {
    if (item.ref) {
      this.goListing.emit(item.ref);
    }
  }

  toggleSelection(item: ChatListingItem, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) {
      this.selectedRefs.add(item.ref);
    } else {
      this.selectedRefs.delete(item.ref);
    }
  }

  getUnavailableReasonKey(item: ChatListingItem): string {
    if (item.status === 'sold') return 'msg.statusSold';
    if (item.status === 'reserved') return 'msg.statusReserved';
    return 'msg.statusRemoved';
  }

  get hasAvailableListings(): boolean {
    return this.listings.some((l) => l.is_available);
  }

  get selectedCount(): number {
    return this.getSelectedListings().length;
  }

  get selectedTotal(): number {
    return this.getSelectedListings().reduce((sum, l) => sum + (l.price || 0), 0);
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

  onOrderClick(): void {
    // Uses 'msg.orderAction' (with 'msg.buyNow' fallback intent) for placing an order from chat
    const selected = this.getSelectedListings();
    if (!selected.length) return;
    const ids = selected.map((l) => l.id || l.ref);
    this.startOrder.emit(ids);
  }

  getSelectedListings(): ChatListingItem[] {
    return this.listings.filter((l) => l.is_available && this.selectedRefs.has(l.ref));
  }
}
