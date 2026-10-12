import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, ChangeDetectorRef, DestroyRef, Input, OnChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  AdminBookRequestRow,
  AdminStatsService,
  RequestSummary,
  StatsDays,
} from '../../core/services/admin-stats.service';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { DropdownOption, UiDropdown } from '../../shared/ui/dropdown.component';
import { RegionLinkService } from '../../core/region-link.service';
import { AdminRankingChartComponent, RankingBar } from './ranking-chart.component';
import { STATS_PAGE_STYLES, StatsFormat } from './stats-widgets';

/**
 * Books people have asked for ("求書"), kept apart from the transaction
 * ranking: a request is demand nobody has met yet, and it stays on record
 * after a listing answers it, so beside sales figures it would overstate how
 * many people are still waiting.
 *
 * Its filters live in their own query params (rq / runlisted / rpage) so they
 * sit beside the transaction ranking's in the dashboard URL.
 */
@Component({
  selector: 'admin-request-ranking',
  standalone: true,
  imports: [
    RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiSearchBarComponent, UiPagination,
    AdminRankingChartComponent, UiDropdown, BookCoverPipe,
  ],
  template: `
    <section class="card">
      <h3>{{ 'admin.stats.requestRanking' | t }}</h3>
      <p class="card-note">{{ 'admin.stats.requestRankingNote' | t }}</p>

      <div class="summary" *ngIf="summary as s">
        <div class="tile">
          <span class="tile-label">{{ 'admin.stats.requestCount' | t }}</span>
          <span class="tile-value">{{ fmt.int(s.total) }}</span>
          <span class="tile-sub">{{ 'admin.stats.newRequests' | t }} {{ fmt.int(s.new) }}</span>
        </div>
        <div class="tile">
          <span class="tile-label">{{ 'admin.stats.requestedBooks' | t }}</span>
          <span class="tile-value">{{ fmt.int(s.requested_books) }}</span>
        </div>
        <div class="tile">
          <span class="tile-label">{{ 'admin.stats.unlistedBooks' | t }}</span>
          <span class="tile-value" [class.warn]="s.unlisted_books > 0">{{ fmt.int(s.unlisted_books) }}</span>
        </div>
      </div>

      <div class="admin-filters">
        <ui-search-bar [placeholder]="'admin.stats.searchBook' | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
        <ui-dropdown
          [label]="'admin.stats.show' | t"
          [options]="showOptions"
          [searchable]="false"
          [ngModel]="unlisted ? 'unlisted' : 'all'"
          (ngModelChange)="onUnlistedChange($event === 'unlisted')"
        ></ui-dropdown>
      </div>

      <div *ngIf="bars.length" class="chart-block" [class.stale]="loading">
        <h4 class="chart-title">{{ 'admin.stats.rankingChartTitle' | t: { n: bars.length } }}</h4>
        <admin-ranking-chart
          [rows]="bars"
          [valueLabel]="'admin.stats.requestCount' | t"
          [format]="barFormat"
          (barClick)="openBook($event)"
        ></admin-ranking-chart>
      </div>

      <ui-skeleton *ngIf="!rows && loading" variant="table" [count]="5"></ui-skeleton>

      <ui-error-state *ngIf="!rows && !loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>
      <div class="table-container" *ngIf="rows" [class.stale]="loading">
        <table class="admin-table admin-table-clickable">
          <thead>
            <tr>
              <th class="num">{{ 'admin.stats.rank' | t }}</th>
              <th>{{ 'admin.colBook' | t }}</th>
              <th class="num">{{ 'admin.stats.requestCount' | t }}</th>
              <th class="num">{{ 'admin.stats.newRequests' | t }}</th>
              <th class="num">{{ 'admin.stats.waitingCount' | t }}</th>
              <th class="num">{{ 'admin.stats.activeListings' | t }}</th>
              <th class="nowrap">{{ 'admin.stats.lastRequestedAt' | t }}</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let row of rows" [regionLink]="['/admin/stats/books', row.book.id]" [queryParams]="{ days: days }">
              <td class="num rank">{{ row.rank === null ? '—' : fmt.int(row.rank) }}</td>
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
              <td class="num strong">{{ fmt.int(row.request_count) }}</td>
              <td class="num">{{ fmt.int(row.new_requests) }}</td>
              <td class="num">{{ fmt.int(row.waiting_count) }}</td>
              <td class="num">
                <span *ngIf="row.active_listings > 0; else none">{{ fmt.int(row.active_listings) }}</span>
                <ng-template #none><span class="admin-badge admin-badge-error">{{ 'admin.stats.notListed' | t }}</span></ng-template>
              </td>
              <td class="nowrap">{{ row.last_requested_at | date: 'yyyy/MM/dd' }}</td>
            </tr>
            <tr *ngIf="rows.length === 0">
              <td colspan="7" class="empty-note">{{ (q ? 'common.noMatches' : 'common.noData') | t }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
    </section>
  `,
  styles: [STATS_PAGE_STYLES, `
    .summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap: 12px; margin-bottom: 16px; }
    .tile { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 6px; background: var(--paper-warm); min-width: 0; }
    .tile-label { font-size: var(--text-xs); color: var(--muted); }
    .tile-value { font-size: var(--text-lg); font-weight: 700; font-variant-numeric: tabular-nums; }
    .tile-value.warn { color: var(--danger); }
    .tile-sub { font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums; }
    .admin-table { min-width: 720px; }
  `],
})
export class AdminRequestRankingComponent implements OnChanges {
  private stats = inject(AdminStatsService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);

  readonly fmt = new StatsFormat(this.i18n);

  @Input({ required: true }) region!: string;
  @Input({ required: true }) days!: StatsDays;

  q: string;
  unlisted: boolean;
  page: number;
  pageSize = 20;

  rows: AdminBookRequestRow[] | null = null;
  bars: RankingBar[] = [];
  readonly barFormat = (value: number) => this.fmt.int(value);
  summary: RequestSummary | null = null;
  total = 0;
  loading = true;
  /** Why the last load failed, shown with a retry in place of the section. */
  loadError = '';

  private sub?: Subscription;

  constructor() {
    const qp = this.route.snapshot.queryParamMap;
    this.q = qp.get('rq') ?? '';
    this.unlisted = qp.get('runlisted') === '1';
    this.page = Math.max(1, Number(qp.get('rpage')) || 1);
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
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

  onUnlistedChange(unlisted: boolean) {
    this.unlisted = unlisted;
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onPageChange(page: number) {
    this.page = page;
    this.syncUrl();
    this.load();
  }

  get showOptions(): DropdownOption[] {
    return [
      { value: 'all', label: this.i18n.t('admin.stats.allRequested') },
      { value: 'unlisted', label: this.i18n.t('admin.stats.onlyUnlisted') },
    ];
  }

  openBook(bar: RankingBar) {
    this.router.navigate(this.regionLink.path(['/admin/stats/books', bar.id]), { queryParams: { days: this.days } });
  }

  private syncUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        rq: this.q || null,
        runlisted: this.unlisted ? 1 : null,
        rpage: this.page > 1 ? this.page : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  load() {
    if (!this.region) return;
    this.sub?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    this.sub = this.stats
      .getBookRequests({
        region: this.region,
        days: this.days,
        unlisted: this.unlisted,
        q: this.q,
        page: this.page,
        page_size: this.pageSize,
      })
      .subscribe({
        next: (res) => {
          this.rows = res.results;
          this.bars = res.results.slice(0, 10).map(r => ({ id: r.book.id, label: r.book.title, value: r.request_count }));
          this.summary = res.summary;
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
