import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, ChangeDetectorRef, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription, map } from 'rxjs';
import { AdminService, AdminBook, AdminBookReviewFilter } from '../../core/services/admin.service';
import { parseAdminError } from '../../core/admin-error.util';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { RegionService } from '../../core/region.service';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiButton } from '../../shared/ui/button.component';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';
import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';

/**
 * Every book of the region, sold or not. The stats ranking only reaches
 * books with transactions, so a misread ISBN on a book nobody bought could
 * not be found to be corrected. The review filter narrows it to the books
 * sellers typed in by hand, which an admin checks against the catalogues.
 * Ticked books are confirmed, or sent back to review, together.
 */
@Component({
  selector: 'app-admin-books-list',
  standalone: true,
  imports: [
    RegionLinkDirective,
    CommonModule,
    RouterModule,
    FormsModule,
    TPipe, UiSkeleton, UiErrorState,
    UiDropdown,
    UiButton,
    AdminBulkBarComponent,
    AdminPickCellComponent,
    UiSearchBarComponent,
    UiPagination,
    BookCoverPipe,
  ],
  template: `
    <div class="admin-filters">
      <ui-search-bar
        [placeholder]="'admin.searchBooks' | t"
        [value]="q"
        (search)="onSearch($event)"
      ></ui-search-bar>
      <ui-dropdown
        [label]="'admin.book.reviewFilter' | t"
        [options]="reviewOptions"
        [(ngModel)]="review"
        (ngModelChange)="onFilterChange()"
        [searchable]="false"
      ></ui-dropdown>
    </div>

    <admin-bulk-bar *ngIf="!loading && !loadError && books.length" [count]="bulk.selection.size" [busy]="bulk.busy" (clear)="bulk.selection.clear()">
      <ui-button size="sm" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkConfirm()">{{
        'admin.book.confirmManual' | t
      }}</ui-button>
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkReopen()">{{
        'admin.book.reopenReview' | t
      }}</ui-button>
    </admin-bulk-bar>

    <ui-skeleton *ngIf="loading" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="reload()"></ui-error-state>

    <div class="table-container">
      <table class="admin-table admin-table-clickable" *ngIf="!loading && !loadError">
        <thead>
          <tr>
            <th adminPick
              [checked]="bulk.selection.allOf(pageIds)"
              [indeterminate]="bulk.selection.size > 0 && !bulk.selection.allOf(pageIds)"
              [disabled]="bulk.busy || !pageIds.length"
              [label]="'admin.bulk.selectAll' | t"
              (toggle)="bulk.selection.toggleAll(pageIds)"></th>
            <th>{{ 'admin.colBook' | t }}</th>
            <th>{{ 'admin.book.authors' | t }}</th>
            <th>ISBN</th>
            <th class="num">{{ 'admin.stats.activeListings' | t }}</th>
            <th class="num">{{ 'admin.stats.requestCount' | t }}</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let book of books" [regionLink]="[book.id]" [class.picked]="bulk.selection.has(book.id)">
            <td adminPick
              [checked]="bulk.selection.has(book.id)"
              [disabled]="bulk.busy"
              [label]="'admin.bulk.selectRow' | t: { name: book.title }"
              (toggle)="bulk.selection.toggle(book.id)"></td>
            <td>
              <div class="book-cell">
                <img
                  *ngIf="book.cover_url; else noCover"
                  class="cover"
                  [src]="book.cover_url | bookCover: 1"
                  alt=""
                  loading="lazy"
                />
                <ng-template #noCover><span class="cover"></span></ng-template>
                <span class="title">{{ book.title }}</span>
                <span *ngIf="book.pending_review" class="admin-status-badge warn">{{
                  'admin.book.reviewPending' | t
                }}</span>
              </div>
            </td>
            <td>{{ book.authors || '—' }}</td>
            <td class="isbn">{{ book.isbn13 || '—' }}</td>
            <td class="num">{{ book.active_listings }}</td>
            <td class="num">{{ book.request_count }}</td>
          </tr>
          <tr *ngIf="books.length === 0">
            <td colspan="6" class="empty-note">
              {{ (q || review ? 'common.noMatches' : 'common.noData') | t }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ui-pagination
      [total]="total"
      [pageSize]="pageSize"
      [currentPage]="page"
      (pageChange)="onPageChange($event)"
    ></ui-pagination>
  `,
  styles: [
    `
      .book-cell {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .cover {
        width: 32px;
        height: 44px;
        flex-shrink: 0;
        object-fit: cover;
        border-radius: 3px;
        border: 1px solid var(--line);
        background: var(--paper-warm);
      }
      .title {
        overflow-wrap: anywhere;
      }
      .book-cell .admin-status-badge {
        flex-shrink: 0;
        white-space: nowrap;
      }
      .isbn {
        font-family: monospace;
        white-space: nowrap;
      }
      .num {
        text-align: right;
      }
    `,
  ],
})
export class AdminBooksListComponent {
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private regionService = inject(RegionService);

  books: AdminBook[] = [];
  total = 0;
  page = 1;
  pageSize = 20;
  q = '';
  review: AdminBookReviewFilter | '' = '';
  loading = true;
  /** Why the last load failed; the table would otherwise read as empty. */
  loadError = '';
  bulk = new BulkController<number>(() => this.reload());
  private sub?: Subscription;

  constructor() {
    effect(() => {
      this.regionService.region();
      untracked(() => {
        this.page = 1;
        this.reload();
      });
    });
  }

  onSearch(q: string) {
    this.q = q;
    this.page = 1;
    this.reload();
  }

  get pageIds(): number[] {
    return this.books.map((b) => b.id);
  }

  /** Only manual books still to review are confirmed; the server skips the rest. */
  bulkConfirm() {
    this.bulk.runBatch((ids) => this.adminService.confirmManualBooks(ids).pipe(map((r) => r.confirmed)), {
      confirm: this.i18n.t('admin.book.bulkConfirmPrompt', { n: this.bulk.selection.size }),
      confirmLabel: this.i18n.t('admin.book.confirmManual'),
    });
  }

  /** Only confirmed manual books go back to review; the server skips the rest. */
  bulkReopen() {
    this.bulk.runBatch((ids) => this.adminService.reopenBookReviews(ids).pipe(map((r) => r.reopened)), {
      confirm: this.i18n.t('admin.book.reopenPrompt', { n: this.bulk.selection.size }),
      confirmLabel: this.i18n.t('admin.book.reopenReview'),
    });
  }

  get reviewOptions() {
    return [
      { value: '', label: this.i18n.t('admin.filterAll') },
      { value: 'pending', label: this.i18n.t('admin.book.reviewPending') },
      { value: 'confirmed', label: this.i18n.t('admin.book.reviewConfirmed') },
    ];
  }

  onFilterChange() {
    this.page = 1;
    this.reload();
  }

  onPageChange(page: number) {
    this.page = page;
    this.reload();
  }

  reload() {
    this.sub?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    this.bulk.reset();
    this.sub = this.adminService
      .getBooks({
        page: this.page,
        q: this.q,
        review: this.review,
        region: this.regionService.region().toUpperCase(),
      })
      .subscribe({
        next: (res) => {
          this.books = res.results;
          this.total = res.count;
          this.loading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
          this.loading = false;
          this.cdr.markForCheck();
        },
      });
  }
}
