import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, ChangeDetectorRef, DestroyRef, ViewChild, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminBookStats, AdminStatsService, StatsDays } from '../../core/services/admin-stats.service';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { RegionService } from '../../core/region.service';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { AdminTrendChartComponent, TrendPoint } from './trend-chart.component';
import { AdminBookEditComponent } from './book-edit.component';
import { AdminBookRecord } from '../../core/services/admin.service';
import { HasUnsavedChanges } from '../../core/unsaved-changes.guard';
import { AdminStatsPeriodComponent, AdminStatusBarComponent, STATS_PAGE_STYLES, StatsFormat, StatsPeriodMemory } from './stats-widgets';

@Component({
  selector: 'app-admin-book-stats',
  standalone: true,
  imports: [
    RegionLinkDirective, CommonModule, RouterModule, TPipe, UiSkeleton, UiErrorState, PricePipe,
    AdminTrendChartComponent, AdminStatsPeriodComponent, AdminStatusBarComponent, BookCoverPipe,
    AdminBookEditComponent,
  ],
  template: `
    <a [regionLink]="['/admin', 'stats', 'books']" [queryParams]="{ days: days }" class="back-link">&larr; {{ 'admin.stats.backToBooks' | t }}</a>

    <ui-skeleton *ngIf="!data && loading" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state *ngIf="!data && !loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>

    <div *ngIf="data as d" [class.stale]="loading">
      <div class="section-head-row">
        <h2 class="book-title">{{ d.book.title }}</h2>
        <admin-stats-period [days]="days" (daysChange)="onDaysChange($event)"></admin-stats-period>
      </div>
      <div class="book-head">
        <img *ngIf="d.book.cover_url; else noCover" class="cover" [src]="d.book.cover_url | bookCover: 3" alt="" />
        <ng-template #noCover><span class="cover cover-empty"></span></ng-template>
        <div class="book-info">
          <p *ngIf="d.book.authors">{{ d.book.authors }}</p>
          <p class="meta">
            <span *ngIf="d.book.publisher">{{ d.book.publisher }}</span>
            <span *ngIf="d.book.isbn13">ISBN {{ d.book.isbn13 }}</span>
          </p>
        </div>
      </div>

      <admin-book-edit
        *ngIf="record"
        [bookId]="bookId"
        [book]="record!"
        [currentSource]="d.book.source"
        (saved)="load()"
        (merged)="openMerged($event)"
      ></admin-book-edit>

      <section class="kpi-grid">
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.rank' | t }}</span>
          <span class="kpi-value" [class.accent]="d.summary.rank !== null">{{ d.summary.rank === null ? '—' : '#' + fmt.int(d.summary.rank) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.completedTransactions' | t }}</span>
          <span class="kpi-value">{{ fmt.int(d.summary.completed_count) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.allTimeCompleted' | t }} {{ fmt.int(d.summary.all_time_completed) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.orderCount' | t }}</span>
          <span class="kpi-value">{{ fmt.int(d.summary.order_count) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.cancelledShort' | t }} {{ fmt.int(d.summary.cancelled_count) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.gmv' | t }}</span>
          <span class="kpi-value">{{ d.summary.gmv | price: d.currency }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.avgPrice' | t }}</span>
          <span class="kpi-value">{{ d.summary.avg_price === null ? '—' : (d.summary.avg_price | price: d.currency) }}</span>
          <span class="kpi-sub" *ngIf="d.summary.min_price !== null">
            {{ d.summary.min_price | price: d.currency }} – {{ d.summary.max_price | price: d.currency }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.activeListings' | t }}</span>
          <span class="kpi-value">{{ fmt.int(d.summary.active_listings) }}</span>
        </div>
      </section>

      <section class="card">
        <h3>{{ (hourly ? 'admin.stats.hourlyTrend' : 'admin.stats.dailyTrend') | t }}</h3>
        <p *ngIf="days === 0" class="card-note">{{ 'admin.stats.seriesCapped' | t }}</p>
        <admin-trend-chart
          [series]="trend"
          [barLabel]="'admin.stats.completedTransactions' | t"
          [lineLabel]="'admin.stats.newOrders' | t"
        ></admin-trend-chart>
      </section>

      <div class="grid-2">
        <section class="card">
          <h3>{{ 'admin.stats.orderStatus' | t }}</h3>
          <admin-status-bar [counts]="d.by_status"></admin-status-bar>
        </section>
        <section class="card">
          <h3>{{ 'admin.stats.topSchools' | t }}</h3>
          <ul *ngIf="d.top_schools.length; else noData" class="rows">
            <li *ngFor="let s of d.top_schools">
              <span>{{ s.name }}</span><strong>{{ fmt.int(s.completed_orders) }}</strong>
            </li>
          </ul>
        </section>
      </div>

      <section class="card">
        <h3>{{ 'admin.stats.requests' | t }}</h3>
        <p class="card-note">{{ 'admin.stats.requestsNote' | t }}</p>
        <ul *ngIf="d.requests.request_count; else noRequests" class="rows requests">
          <li><span>{{ 'admin.stats.requestRank' | t }}</span><strong>{{ d.requests.rank === null ? '—' : '#' + fmt.int(d.requests.rank) }}</strong></li>
          <li><span>{{ 'admin.stats.requestCount' | t }}</span><strong>{{ fmt.int(d.requests.request_count) }}</strong></li>
          <li><span>{{ 'admin.stats.newRequests' | t }}</span><strong>{{ fmt.int(d.requests.new_requests) }}</strong></li>
          <li><span>{{ 'admin.stats.notifiedCount' | t }}</span><strong>{{ fmt.int(d.requests.notified_count) }}</strong></li>
          <li>
            <span>{{ 'admin.stats.waitingCount' | t }}</span>
            <strong [class.warn]="d.requests.waiting_count > 0 && d.summary.active_listings === 0">{{ fmt.int(d.requests.waiting_count) }}</strong>
          </li>
          <li><span>{{ 'admin.stats.lastRequestedAt' | t }}</span><strong>{{ d.requests.last_requested_at | date: 'yyyy/MM/dd' }}</strong></li>
        </ul>
        <ng-template #noRequests><div class="empty-note">{{ 'admin.stats.noRequests' | t }}</div></ng-template>
      </section>

      <section class="card">
        <h3>{{ 'admin.stats.recentOrders' | t }}</h3>
        <div class="table-container" *ngIf="d.recent_orders.length; else noData">
          <table class="admin-table admin-table-clickable">
            <thead>
              <tr>
                <th>{{ 'admin.stats.date' | t }}</th>
                <th>{{ 'admin.colSchool' | t }}</th>
                <th>{{ 'admin.colStatus' | t }}</th>
                <th class="num">{{ 'admin.colPrice' | t }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let o of d.recent_orders" [regionLink]="['../../../orders', o.id]">
                <td class="nowrap">{{ o.created_at | date: 'yyyy/MM/dd HH:mm' }}</td>
                <td>{{ o.school_name || '—' }}</td>
                <td><span class="admin-status-badge">{{ ('order.status.' + o.status) | t }}</span></td>
                <td class="num">{{ o.total_amount | price: d.currency }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <h3>{{ 'admin.stats.activeListings' | t }}</h3>
        <div class="table-container" *ngIf="d.active_listings.length; else noData">
          <table class="admin-table admin-table-clickable">
            <thead>
              <tr>
                <th class="num">{{ 'admin.colPrice' | t }}</th>
                <th>{{ 'common.condition' | t }}</th>
                <th>{{ 'admin.colSchool' | t }}</th>
                <th>{{ 'admin.stats.listedAt' | t }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let l of d.active_listings" [regionLink]="['../../../listings', l.id]">
                <td class="num">{{ l.price | price: d.currency }}</td>
                <td>{{ ('cond.' + l.condition) | t }}</td>
                <td>{{ l.school_name || '—' }}</td>
                <td class="nowrap">{{ l.created_at | date: 'yyyy/MM/dd' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <ng-template #noData><div class="empty-note">{{ 'common.noData' | t }}</div></ng-template>
  `,
  styles: [STATS_PAGE_STYLES, `
    .book-title { overflow-wrap: anywhere; min-width: 0; }
    .book-head { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 24px; }
    .cover { width: 72px; height: 100px; flex-shrink: 0; object-fit: cover; border-radius: 4px; border: 1px solid var(--line); background: var(--paper-warm); }
    .cover-empty { display: inline-block; }
    .book-info { flex: 1; min-width: 0; }
    .book-info p { margin: 0 0 2px; color: var(--ink-soft); }
    .book-info .meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--text-sm); color: var(--muted); }
    .rows.requests { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); column-gap: 24px; }
    .admin-table { min-width: 520px; }
  `],
})
export class AdminBookStatsComponent implements HasUnsavedChanges {
  private stats = inject(AdminStatsService);
  private i18n = inject(I18nService);
  private regionService = inject(RegionService);
  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  readonly fmt = new StatsFormat(this.i18n);
  bookId = Number(this.route.snapshot.paramMap.get('id'));
  /** The book's details as the edit form takes them. */
  record: AdminBookRecord | null = null;
  @ViewChild(AdminBookEditComponent) private editor?: AdminBookEditComponent;

  private period = inject(StatsPeriodMemory);
  days: StatsDays = this.period.resolve(this.route.snapshot.queryParamMap.get('days'));
  data: AdminBookStats | null = null;
  trend: TrendPoint[] = [];
  /** Today's chart is split by hour; the others by day. */
  hourly = false;
  loading = true;
  /** Why the last load failed, shown with a retry in place of the section. */
  loadError = '';

  private sub?: Subscription;

  constructor() {
    effect(() => {
      this.regionService.region();
      untracked(() => this.load());
    });
    // A merge sends this same component to the book it merged into.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(params => {
      const id = Number(params.get('id'));
      if (id === this.bookId) return;
      this.bookId = id;
      this.data = null;
      this.record = null;
      this.load();
    });
    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
  }

  onDaysChange(days: StatsDays) {
    this.days = days;
    this.period.days.set(days);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { days },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    this.load();
  }

  hasUnsavedChanges(): boolean {
    return this.editor?.hasUnsavedChanges() ?? false;
  }

  unsavedChangesMessage(): string {
    return this.i18n.t('admin.book.unsavedChanges');
  }

  /** This book was folded into another; its page no longer exists. */
  openMerged(id: number) {
    this.router.navigate(['..', id], { relativeTo: this.route, queryParams: { days: this.days }, replaceUrl: true });
  }

  load() {
    this.sub?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    this.sub = this.stats.getBookStats(this.bookId, this.regionService.region().toUpperCase(), this.days).subscribe({
      next: (res) => {
        this.data = res;
        const b = res.book;
        this.record = {
          isbn13: b.isbn13 || '', title: b.title, authors: b.authors || '',
          publisher: b.publisher || '', published_date: b.published_date || '', cover_url: b.cover_url || '',
        };
        this.trend = res.series.map(p => ({ date: p.date, bar: p.completed, line: p.orders }));
        this.hourly = res.series_unit === 'hour';
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.data = null;
        this.loading = false;
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.cdr.markForCheck();
      },
    });
  }
}
