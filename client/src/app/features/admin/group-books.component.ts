import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, ChangeDetectorRef, DestroyRef, Input, OnChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  AdminBookRankingRow, AdminStatsService, BookScope, StatsDays,
} from '../../core/services/admin-stats.service';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { RegionLinkService } from '../../core/region-link.service';
import { UiPagination } from '../../shared/ui/pagination.component';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { AdminRankingChartComponent, RankingBar } from './ranking-chart.component';
import { STATS_PAGE_STYLES, StatsFormat } from './stats-widgets';

const PAGE_SIZE = 10;

/**
 * The books traded inside one school, college, course or professor — what a
 * row of the breakdown table shows when it is opened. Ranked by completed
 * transactions in the period.
 */
@Component({
  selector: 'admin-group-books',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, TPipe, UiSkeleton, UiErrorState, UiPagination, PricePipe, AdminRankingChartComponent],
  template: `
    <div class="group-books" [class.stale]="loading && rows">
      <h4 class="chart-title">{{ 'admin.stats.groupBooksTitle' | t: { name: name } }}</h4>
      <ui-skeleton *ngIf="!rows && loading" variant="table" [count]="5"></ui-skeleton>
      <ui-error-state *ngIf="!rows && !loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>
      <div *ngIf="rows && rows.length === 0" class="empty-note">{{ 'admin.stats.groupBooksEmpty' | t }}</div>

      <ng-container *ngIf="rows?.length">
        <admin-ranking-chart
          *ngIf="bars.length"
          [rows]="bars"
          [valueLabel]="'admin.stats.completedTransactions' | t"
          [format]="barFormat"
          (barClick)="openBook($event)"
        ></admin-ranking-chart>

        <div class="table-container">
          <table class="admin-table admin-table-clickable compact">
            <thead>
              <tr>
                <th class="num">{{ 'admin.stats.rank' | t }}</th>
                <th>{{ 'admin.colBook' | t }}</th>
                <th class="num">{{ 'admin.stats.completedShort' | t }}</th>
                <th class="num">{{ 'admin.stats.orderCount' | t }}</th>
                <th class="num">{{ 'admin.stats.gmv' | t }}</th>
                <th class="num">{{ 'admin.stats.avgPrice' | t }}</th>
                <th class="num">{{ 'admin.stats.activeListings' | t }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let row of rows" [regionLink]="['/admin/stats/books', row.book.id]" [queryParams]="{ days: days }">
                <td class="num rank">{{ row.rank === null ? '—' : fmt.int(row.rank) }}</td>
                <td>
                  <span class="book-title">{{ row.book.title }}</span>
                  <span class="book-meta" *ngIf="row.book.isbn13"> · {{ row.book.isbn13 }}</span>
                </td>
                <td class="num strong">{{ fmt.int(row.completed_count) }}</td>
                <td class="num">{{ fmt.int(row.order_count) }}</td>
                <td class="num">{{ row.gmv | price: currency }}</td>
                <td class="num">{{ row.avg_price === null ? '—' : (row.avg_price | price: currency) }}</td>
                <td class="num">{{ fmt.int(row.active_listings) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ui-pagination *ngIf="total > pageSize" [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
      </ng-container>
    </div>
  `,
  styles: [STATS_PAGE_STYLES, `
    .group-books { padding: 12px 4px 4px; }
    .group-books admin-ranking-chart { margin-bottom: 12px; }
    .admin-table.compact { min-width: 560px; background: transparent; }
  `],
})
export class AdminGroupBooksComponent implements OnChanges {
  private stats = inject(AdminStatsService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);

  readonly fmt = new StatsFormat(this.i18n);
  readonly pageSize = PAGE_SIZE;

  @Input({ required: true }) region!: string;
  @Input({ required: true }) days!: StatsDays;
  @Input({ required: true }) scope!: BookScope;
  /** The row's display name, for the heading. */
  @Input() name = '';

  rows: AdminBookRankingRow[] | null = null;
  bars: RankingBar[] = [];
  currency = '';
  total = 0;
  page = 1;
  loading = true;
  /** Why the last load failed, shown with a retry in place of the section. */
  loadError = '';
  readonly barFormat = (value: number) => this.fmt.int(value);

  private sub?: Subscription;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
  }

  ngOnChanges() {
    this.page = 1;
    this.load();
  }

  onPageChange(page: number) {
    this.page = page;
    this.load();
  }

  openBook(bar: RankingBar) {
    this.router.navigate(this.regionLink.path(['/admin/stats/books', bar.id]), { queryParams: { days: this.days } });
  }

  load() {
    this.sub?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    this.sub = this.stats
      .getBookRanking({
        region: this.region,
        days: this.days,
        sort: 'completed',
        page: this.page,
        page_size: this.pageSize,
        ...this.scope,
      })
      .subscribe({
        next: (res) => {
          this.rows = res.results;
          this.currency = res.currency;
          this.total = res.count;
          this.bars = res.results
            .filter(r => r.completed_count > 0)
            .map(r => ({ id: r.book.id, label: r.book.title, value: r.completed_count }));
          this.loading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.rows = null;
          this.bars = [];
          this.loading = false;
          this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
          this.cdr.markForCheck();
        },
      });
  }
}
