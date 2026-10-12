import { Component, Input, Output, EventEmitter, inject, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiBadge } from './badge.component';
import { UiButton } from './button.component';
import { UiBookCover } from './book-cover.component';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { I18nService, TPipe } from '../../core/i18n.service';
import { CountCapPipe } from '../pipes/count-cap.pipe';
import { PricePipe } from '../pipes/price.pipe';

@Component({
  selector: 'ui-listing-row',
  standalone: true,
  imports: [CommonModule, UiBadge, UiButton, UiBookCover, TPipe, CountCapPipe, PricePipe, RegionLinkDirective],
  template: `
    <div class="listing-row">
      <div class="cover">
        <ui-book-cover
          [coverUrl]="coverUrl"
          [title]="title"
          [author]="authorLine"
          [isbn]="isbnLine"
        ></ui-book-cover>
      </div>
      <div class="info">
        <h3 class="title book-title-serif">
          <a *ngIf="titleLink; else plainTitle" class="title-link" [regionLink]="titleLink">{{ title }}</a>
          <ng-template #plainTitle>{{ title }}</ng-template>
        </h3>
        <ng-container *ngIf="authorLine && isbnLine; else metaFallback">
          <p class="meta">
            <span class="meta-author">{{ authorLine }}</span><span class="meta-isbn">{{ isbnLine }}</span>
          </p>
        </ng-container>
        <ng-template #metaFallback>
          <p class="meta" *ngIf="metaInfo">{{ metaInfo }}</p>
        </ng-template>
        <p class="course" *ngIf="courseInfo">{{ courseInfo }}</p>
        <p class="note" *ngIf="noteInfo">{{ noteInfo }}</p>
        <p class="stamp" *ngIf="listedAt">{{ 'row.listedOn' | t:{ date: listedAt } }}</p>
      </div>
      <div class="actions">
        <div class="price" [class.aggregate]="variant === 'aggregate'" *ngIf="price !== undefined && price !== null">{{ price | price }}</div>
        
        <!-- badges -->
        <ui-badge *ngIf="status === 'active'" type="waitlist">{{ 'row.active' | t }}</ui-badge>
        <ui-badge *ngIf="status === 'sold'" condition="noted">{{ 'row.sold' | t }}</ui-badge>
        <ui-badge *ngIf="status === 'reserved'" condition="damaged">{{ 'row.reserved' | t }}</ui-badge>
        <!-- 'removed', not 'inactive'. The backend's STATUS_CHOICES are
             active/reserved/sold/removed, so this badge never rendered, and a
             listing that moderation took down sat in the seller's own list
             looking untouched with nothing to say what had happened. -->
        <ui-badge *ngIf="status === 'removed'" condition="damaged">{{ 'row.removed' | t }}</ui-badge>
        <ui-badge *ngIf="condition && (!status || status === 'active')" [condition]="condition">{{ conditionText }}</ui-badge>
        <div class="condition-summary" *ngIf="conditionSummary">{{ conditionSummary }}</div>
        <ui-badge *ngIf="waitlistCount" type="waitlist">{{ 'home.waitingCount' | t:{n: waitlistCount | countCap} }}</ui-badge>

        <!-- management buttons. Which ones make sense depends on the status:
             a removed listing cannot be "marked sold", and only a listing
             nobody has reserved is safe to take down or delete. -->
        <div class="manage-actions" *ngIf="isEditable">
          <span *ngIf="adminLocked" class="locked-text" [attr.title]="adminLockReason || null">{{ 'row.adminLocked' | t }}</span>
          <ui-button variant="ghost" *ngIf="status !== 'removed'" (onClick)="action.emit({type: 'copy_link', id: id})">{{ 'row.copyLink' | t }}</ui-button>
          <ui-button variant="ghost" [disabled]="adminLocked" (onClick)="action.emit({type: 'edit', id: id})">{{ 'common.edit' | t }}</ui-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      container-type: inline-size;
    }
    .listing-row {
      display: flex;
      gap: 16px;
      padding: 16px 0;
      border-bottom: 1px solid var(--line);
      align-items: flex-start;
    }
    .cover {
      width: 88px;
      height: 124px;
      flex-shrink: 0;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card);
      background-color: var(--paper-warm);
      overflow: hidden;
    }
    .info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .title {
      margin: 0;
      font-size: var(--text-lg);
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .title-link { color: inherit; text-decoration: none; }
    .title-link:hover { color: var(--accent); text-decoration: underline; }
    .stamp {
      margin: 2px 0 0;
      font-size: var(--text-sm);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .meta, .course, .note {
      margin: 0;
      font-size: var(--text-base);
      color: var(--muted);
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .note {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .actions {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      min-width: 100px;
      flex-shrink: 0;
    }
    .price {
      font-size: var(--text-xl);
      font-weight: 700;
      color: var(--accent);
      font-variant-numeric: tabular-nums;
    }
    .price.aggregate {
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--muted);
    }
    .condition-summary {
      font-size: var(--text-sm);
      color: var(--muted);
      text-align: right;
      overflow-wrap: anywhere;
      word-break: break-word;
      max-width: 260px;
    }
    .locked-text {
      align-self: center;
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--danger);
    }
    .manage-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }

    .meta .meta-author::after {
      content: ' • ';
      margin: 0 4px;
    }
    @container (max-width: 580px) {
      .listing-row {
        flex-wrap: wrap;
      }
      .meta .meta-author::after {
        content: '';
        margin: 0;
      }
      .meta .meta-isbn {
        display: block;
        margin-top: 2px;
      }
      .cover {
        width: 64px;
        height: 90px;
      }
      .info {
        flex: 1;
        min-width: 0;
      }
      .actions {
        width: 100%;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        min-width: 0;
        max-width: 100%;
      }
      .condition-summary {
        max-width: 100%;
        word-break: break-word;
        overflow-wrap: anywhere;
        flex-basis: 100%;
        text-align: right;
      }
      .price {
        font-size: var(--text-lg);
      }
      .manage-actions {
        flex-basis: 100%;
        margin-top: 0;
      }
    }
  `]
})
export class UiListingRow implements OnChanges {
  @Input() id!: number | string;
  @Input() coverUrl?: string;
  @Input() title: string = '';
  @Input() metaInfo: string = '';
  @Input() authorLine: string = '';
  @Input() isbnLine: string = '';
  @Input() courseInfo?: string;
  @Input() noteInfo?: string;
  @Input() price?: number;
  @Input() condition?: 'new' | 'like_new' | 'noted' | 'damaged';
  @Input() conditionSummary?: string;
  @Input() status?: string;
  /** Router commands for the public listing page; without them the title is plain text. */
  @Input() titleLink?: any[];
  /** Already-formatted listing date, shown under the meta lines. */
  @Input() listedAt?: string;
  @Input() waitlistCount?: number;
  @Input() isEditable = false;
  @Input() variant: 'listing' | 'aggregate' = 'listing';
  // Taken down by an admin: the backend refuses the seller's edits, so the
  // row says why instead of offering an Edit that would only fail.
  @Input() adminLocked = false;
  @Input() adminLockReason?: string;

  @Output() action = new EventEmitter<{ type: string, id: number | string }>();

  private i18n = inject(I18nService);
  conditionText: string = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['condition']) {
      this.conditionText = this.condition ? this.i18n.t(`cond.${this.condition}`) : '';
    }
  }
}

