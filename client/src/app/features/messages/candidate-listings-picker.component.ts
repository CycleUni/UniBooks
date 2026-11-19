import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  inject,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe, I18nService } from '../../core/i18n.service';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { UiBottomSheet } from '../../shared/ui/bottom-sheet.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { MessageService } from '../../core/services/message.service';
import { ToastService } from '../../core/services/toast.service';

export interface CandidateListing {
  id: string;
  title: string;
  isbn: string;
  price: number;
  condition: string;
  course_name: string;
  cover_url: string;
}

@Component({
  selector: 'app-candidate-listings-picker',
  standalone: true,
  imports: [
    CommonModule,
    TPipe,
    PricePipe,
    BookCoverPipe,
    UiBottomSheet,
    UiButton,
    UiSkeleton,
    UiEmpty,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ui-bottom-sheet [title]="'msg.pickerTitle' | t" (closed)="closed.emit()">
      <div class="picker-container">
        <!-- Loading skeleton -->
        <div *ngIf="isLoading" class="skeleton-list">
          <ui-skeleton variant="list" [count]="3"></ui-skeleton>
        </div>

        <!-- Empty state -->
        <ui-empty
          *ngIf="!isLoading && candidates.length === 0"
          [message]="'msg.noOtherListings' | t"
        ></ui-empty>

        <!-- Candidate items -->
        <div *ngIf="!isLoading && candidates.length > 0" class="candidate-list">
          <div *ngFor="let item of candidates; trackBy: trackById" class="candidate-row">
            <img
              *ngIf="item.cover_url"
              [src]="item.cover_url | bookCover"
              [attr.alt]="item.title || ('common.bookCover' | t)"
              class="candidate-thumb"
            />
            <div class="candidate-thumb placeholder" *ngIf="!item.cover_url"></div>

            <div class="candidate-details">
              <span class="candidate-title">{{ item.title }}</span>
              <div class="candidate-meta">
                <span class="candidate-price">{{ item.price | price }}</span>
                <span class="condition-badge" *ngIf="item.condition">{{ ('cond.' + item.condition) | t }}</span>
                <span class="candidate-course" *ngIf="item.course_name">{{ item.course_name }}</span>
              </div>
            </div>

            <ui-button
              variant="secondary"
              size="sm"
              [disabled]="addingId === item.id"
              (onClick)="addListing(item)"
            >
              {{ 'msg.addListing' | t }}
            </ui-button>
          </div>
        </div>
      </div>
    </ui-bottom-sheet>
  `,
  styles: [`
    .picker-container {
      max-height: 60vh;
      overflow-y: auto;
      padding: 8px 0;
    }

    .skeleton-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 8px 16px;
    }

    .candidate-skeleton-row {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .skeleton-details {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .candidate-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .candidate-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      border-radius: var(--radius-control);
      transition: background var(--motion-fast);
    }

    .candidate-row:hover {
      background: var(--paper-warm);
    }

    .candidate-thumb {
      width: 44px;
      height: 60px;
      object-fit: cover;
      border-radius: var(--radius-xs);
      background: var(--surface-card);
      flex-shrink: 0;
    }

    .candidate-thumb.placeholder {
      background: var(--line);
    }

    .candidate-details {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .candidate-title {
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .candidate-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: var(--text-xs);
      color: var(--muted);
    }

    .candidate-price {
      font-weight: 600;
      color: var(--accent);
    }

    .condition-badge {
      background: var(--line);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }

    .candidate-course {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `],
})
export class CandidateListingsPickerComponent implements OnInit {
  private messageService = inject(MessageService);
  private toast = inject(ToastService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  @Input({ required: true }) conversationId!: string;
  @Output() closed = new EventEmitter<void>();
  @Output() listingAdded = new EventEmitter<any>();

  candidates: CandidateListing[] = [];
  isLoading = true;
  addingId: string | null = null;

  ngOnInit(): void {
    this.loadCandidates();
  }

  trackById(_: number, item: CandidateListing): string {
    return item.id;
  }

  loadCandidates(): void {
    this.isLoading = true;
    this.cdr.markForCheck();

    this.messageService.getCandidateListings(this.conversationId).subscribe({
      next: (res) => {
        this.candidates = res.results || [];
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoading = false;
        this.candidates = [];
        this.cdr.markForCheck();
      },
    });
  }

  addListing(item: CandidateListing): void {
    this.addingId = item.id;
    this.cdr.markForCheck();

    this.messageService.attachListing(this.conversationId, item.id).subscribe({
      next: (updatedConv) => {
        this.addingId = null;
        this.toast.success(this.i18n.t('msg.listingAdded'));
        this.listingAdded.emit(updatedConv);
        this.candidates = this.candidates.filter((c) => c.id !== item.id);
        this.cdr.markForCheck();
        this.closed.emit();
      },
      error: () => {
        this.addingId = null;
        this.cdr.markForCheck();
      },
    });
  }
}
