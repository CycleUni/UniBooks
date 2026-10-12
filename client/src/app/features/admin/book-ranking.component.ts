import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, ChangeDetectorRef, DestroyRef, Input, OnChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  AdminBookRankingRow, AdminStatsService, BookRankingSort, StatsDays,
} from '../../core/services/admin-stats.service';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { RegionLinkService } from '../../core/region-link.service';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { DropdownOption, UiDropdown } from '../../shared/ui/dropdown.component';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { AdminRankingChartComponent, RankingBar } from './ranking-chart.component';
import { STATS_PAGE_STYLES, StatsFormat } from './stats-widgets';

const SORTS: BookRankingSort[] = ['completed', 'gmv', 'orders'];
const SORT_LABELS: Record<BookRankingSort, string> = {
  completed: 'admin.stats.completedTransactions',
  gmv: 'admin.stats.gmv',
  orders: 'admin.stats.orderCount',
};

/**
 * Books ranked by transactions in the period: a bar chart of the current
 * page's top ten over the full table. Its filters live in the q / sort / page
 * query params.
 */
@Component({
  selector: 'admin-book-ranking',
  standalone: true,
  imports: [
    RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiSearchBarComponent, UiPagination,
    PricePipe, AdminRankingChartComponent, UiDropdown, BookCoverPipe,
  ],
  template: `
    <section class="card">
      <div class="section-head-row">
        <h3>{{ 'admin.stats.bookRanking' | t }}</h3>
        <ui-dropdown
          [label]="'admin.stats.sortBy' | t"
          [inlineLabel]="true"
          [compact]="true"
          [options]="sortOptions"
          [searchable]="false"
          [ngModel]="sort"
          (ngModelChange)="onSortChange($event)"
        ></ui-dropdown>
      </div>
      <div class="admin-filters">
        <ui-search-bar [placeholder]="'admin.stats.searchBook' | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
      </div>
      <p class="card-note">{{ (q ? 'admin.stats.rankingSearchNote' : 'admin.stats.rankingNote') | t }}</p>

      <div *ngIf="bars.length" class="chart-block" [class.stale]="loading">
        <h4 class="chart-title">{{ 'admin.stats.rankingChartTitle' | t: { n: bars.length } }}</h4>
        <admin-ranking-chart
          [rows]="bars"
          [valueLabel]="barsLabel | t"
          [format]="barFormat"
          [integer]="barsSort !== 'gmv'"
          (barClick)="openBook($event)"
        ></admin-ranking-chart>
      </div>

      <ui-skeleton *ngIf="!rows && loading" variant="table" [count]="5"></ui-skeleton>

      <ui-error-state *ngIf="!rows && !loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>
      <div class="table-container" *ngIf="rows" [class.stale]="loading">
        <table class="admin-table admin-table-clickable ranking">
          <thead>
            <tr>
              <th class="num">{{ 'admin.stats.rank' | t }}</th>
              <th>{{ 'admin.colBook' | t }}</th>
              <th class="num">{{ 'admin.stats.completedShort' | t }}</th>
              <th class="num">{{ 'admin.stats.orderCount' | t }}</th>
              <th class="num">{{ 'admin.stats.cancelledShort' | t }}</th>
              <th class="num">{{ 'admin.stats.gmv' | t }}</th>
              <th class="num">{{ 'admin.stats.avgPrice' | t }}</th>
              <th class="num">{{ 'admin.stats.activeListings' | t }}</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let row of rows" [regionLink]="['/admin/stats/books', row.book.id]" [queryParams]="{ days: days }">
              <td class="num rank" [class.top]="row.rank !== null && row.rank <= 3">{{ row.rank === null ? '—' : fmt.int(row.rank) }}</td>
              <td>
                <div class="book">
                  <img *ngIf="row.book.cover_url; else noCover" class="thumb" [src]="row.book.cover_url | bookCover: 3" alt="" loading="lazy" />
                  <ng-template #noCover><span class="thumb"></span></ng-template>
                  <div class="book-text">
                    <span class="book-title">{{ row.book.title }}</span>
                    <span class="book-meta">
                      {{ row.book.authors }}<ng-container *ngIf="row.book.authors && row.book.isbn13"> · </ng-container>{{ row.book.isbn13 }}
                    </span>
                  </div>
                </div>
              </td>
              <td class="num strong">{{ fmt.int(row.completed_count) }}</td>
              <td class="num">{{ fmt.int(row.order_count) }}</td>
              <td class="num">{{ fmt.int(row.cancelled_count) }}</td>
              <td class="num">{{ row.gmv | price: currency }}</td>
              <td class="num">{{ row.avg_price === null ? '—' : (row.avg_price | price: currency) }}</td>
              <td class="num">{{ fmt.int(row.active_listings) }}</td>
            </tr>
            <tr *ngIf="rows.length === 0">
              <td colspan="8" class="empty-note">{{ (q ? 'common.noMatches' : 'common.noData') | t }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
    </section>
  `,
  styles: [STATS_PAGE_STYLES, `
    .admin-table.ranking { min-width: 800px; }
  `],
})
export class AdminBookRankingComponent implements OnChanges {
  private stats = inject(AdminStatsService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private price = new PricePipe();

  readonly fmt = new StatsFormat(this.i18n);

  @Input({ required: true }) region!: string;
  @Input({ required: true }) days!: StatsDays;

  q: string;
  sort: BookRankingSort;
  page: number;
  pageSize = 20;

  rows: AdminBookRankingRow[] | null = null;
  currency = '';
  total = 0;
  loading = true;
  /** Why the last load failed, shown with a retry in place of the section. */
  loadError = '';

  /** The chart describes the rows it was built from, not a sort still loading. */
  bars: RankingBar[] = [];
  barsSort: BookRankingSort = 'completed';
  /** Stable reference, so the chart is not told its formatter changed every check. */
  readonly barFormat = (value: number) =>
    this.barsSort === 'gmv' ? this.price.transform(value, this.currency) : this.fmt.int(value);

  private sub?: Subscription;

  constructor() {
    const qp = this.route.snapshot.queryParamMap;
    this.q = qp.get('q') ?? '';
    const sort = qp.get('sort') as BookRankingSort;
    this.sort = SORTS.includes(sort) ? sort : 'completed';
    this.page = Math.max(1, Number(qp.get('page')) || 1);
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
  }

  get sortOptions(): DropdownOption[] {
    return SORTS.map(value => ({ value, label: this.i18n.t(SORT_LABELS[value]) }));
  }

  get barsLabel(): string {
    return SORT_LABELS[this.barsSort];
  }

  /**
   * A new region or period is a new list, so paging starts over. The URL is
   * left to the page: it clears every page param in the same navigation that
   * sets the period, since two navigations in one tick cancel each other.
   */
  ngOnChanges() {
    if (this.rows) this.page = 1;
    this.load();
  }

  onSearch(q: string) {
    this.q = q.trim();
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onSortChange(sort: BookRankingSort) {
    this.sort = sort;
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onPageChange(page: number) {
    this.page = page;
    this.syncUrl();
    this.load();
  }

  openBook(bar: RankingBar) {
    this.router.navigate(this.regionLink.path(['/admin/stats/books', bar.id]), { queryParams: { days: this.days } });
  }

  private syncUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        sort: this.sort === 'completed' ? null : this.sort,
        q: this.q || null,
        page: this.page > 1 ? this.page : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private buildBars(rows: AdminBookRankingRow[], sort: BookRankingSort): RankingBar[] {
    this.barsSort = sort;
    const value = (r: AdminBookRankingRow) =>
      sort === 'gmv' ? r.gmv : sort === 'orders' ? r.order_count : r.completed_count;
    return rows
      .filter(r => value(r) > 0)
      .slice(0, 10)
      .map(r => ({ id: r.book.id, label: r.book.title, value: value(r) }));
  }

  load() {
    if (!this.region) return;
    this.sub?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    this.sub = this.stats
      .getBookRanking({
        region: this.region,
        days: this.days,
        sort: this.sort,
        q: this.q,
        page: this.page,
        page_size: this.pageSize,
      })
      .subscribe({
        next: (res) => {
          this.rows = res.results;
          this.currency = res.currency;
          this.bars = this.buildBars(res.results, res.sort);
          this.total = res.count;
          this.loading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.rows = null;
          this.bars = [];
          this.total = 0;
          this.loading = false;
          this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
          this.cdr.markForCheck();
        },
      });
  }
}
