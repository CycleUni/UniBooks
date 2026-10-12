import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, ChangeDetectorRef, DestroyRef, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { Subscription, forkJoin } from 'rxjs';
import { AdminStatsOverview, AdminStatsService, StatsDays } from '../../core/services/admin-stats.service';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { RegionService } from '../../core/region.service';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { AdminTrendChartComponent, TrendPoint } from './trend-chart.component';
import {
  AdminStatsPeriodComponent, AdminStatusBarComponent, STATS_PAGE_STYLES, StatsFormat, StatsPeriodMemory,
} from './stats-widgets';

/** Listing reports and chat reports share this breakdown. */
const REPORT_REASON_KEYS: Record<string, string> = {
  fake: 'admin.stats.reportReasonFake',
  scam: 'admin.reportReasonScam',
  spam: 'admin.reportReasonSpam',
  harassment: 'admin.reportReasonHarassment',
  other: 'admin.reportReasonOther',
};

@Component({
  selector: 'app-admin-stats-dashboard',
  standalone: true,
  imports: [
    RegionLinkDirective, CommonModule, RouterModule, TPipe, UiSkeleton, UiErrorState, PricePipe,
    AdminTrendChartComponent, AdminStatsPeriodComponent, AdminStatusBarComponent,
  ],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.stats.titleOverview' | t }}</h2>
      <admin-stats-period [days]="days" (daysChange)="onDaysChange($event)"></admin-stats-period>
    </div>

    <ui-skeleton *ngIf="!overview && loadingOverview" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state *ngIf="!overview && !loadingOverview && loadError" [message]="loadError" (retry)="load()"></ui-error-state>

    <div *ngIf="overview as o" class="stats-body" [class.stale]="loadingOverview">
      <p class="scope-note">{{ 'admin.stats.scopeNote' | t: { region: regionName(), currency: o.currency } }}</p>

      <!-- Headline figures -->
      <section class="kpi-grid" [attr.aria-label]="'admin.stats.headline' | t">
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.completedTransactions' | t }}</span>
          <span class="kpi-value">{{ fmt.int(o.orders.by_status.completed) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.gmv' | t }}</span>
          <span class="kpi-value">{{ o.orders.gmv | price: o.currency }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.avgOrderValue' | t }}</span>
          <span class="kpi-value">{{ o.orders.avg_order_value === null ? '—' : (o.orders.avg_order_value | price: o.currency) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.newOrders' | t }}</span>
          <span class="kpi-value">{{ fmt.int(o.orders.new) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.completionRate' | t }}</span>
          <span class="kpi-value">{{ fmt.percent(o.orders.completion_rate) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.cancelRate' | t }} {{ fmt.percent(o.orders.cancel_rate) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.avgDaysToComplete' | t }}</span>
          <span class="kpi-value">{{ fmt.decimal(o.orders.avg_days_to_complete) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.newUsers' | t }}</span>
          <span class="kpi-value">{{ fmt.int(o.users.new) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.totalUsers' | t }} {{ fmt.int(o.users.total) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.openReports' | t }}</span>
          <span class="kpi-value" [class.warn]="o.moderation.open_listing_reports + o.moderation.open_chat_reports > 0">
            {{ fmt.int(o.moderation.open_listing_reports + o.moderation.open_chat_reports) }}
          </span>
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
          <admin-status-bar [counts]="o.orders.by_status"></admin-status-bar>
        </section>
        <section class="card">
          <h3>{{ 'admin.stats.cancelReasons' | t }}</h3>
          <ul *ngIf="o.orders.cancel_reasons.length; else noData" class="rows">
            <li *ngFor="let r of o.orders.cancel_reasons">
              <span>{{ cancelReasonLabel(r.reason) }}</span><strong>{{ fmt.int(r.count) }}</strong>
            </li>
          </ul>
        </section>
      </div>

      <div class="grid-3">
        <section class="card">
          <h3>{{ 'admin.stats.users' | t }}</h3>
          <ul class="rows">
            <li><span>{{ 'admin.stats.totalUsers' | t }}</span><strong>{{ fmt.int(o.users.total) }}</strong></li>
            <li><span>{{ 'admin.stats.newUsers' | t }}</span><strong>{{ fmt.int(o.users.new) }}</strong></li>
            <li><span>{{ 'admin.stats.activeSellers' | t }}</span><strong>{{ fmt.int(o.users.active_sellers) }}</strong></li>
            <li><span>{{ 'admin.stats.activeBuyers' | t }}</span><strong>{{ fmt.int(o.users.active_buyers) }}</strong></li>
          </ul>
        </section>
        <section class="card">
          <h3>{{ 'admin.stats.listings' | t }}</h3>
          <ul class="rows">
            <li><span>{{ 'admin.stats.newListings' | t }}</span><strong>{{ fmt.int(o.listings.new) }}</strong></li>
            <li><span>{{ 'admin.stats.listingActive' | t }}</span><strong>{{ fmt.int(o.listings.by_status.active) }}</strong></li>
            <li><span>{{ 'admin.stats.listingReserved' | t }}</span><strong>{{ fmt.int(o.listings.by_status.reserved) }}</strong></li>
            <li><span>{{ 'admin.stats.listingSold' | t }}</span><strong>{{ fmt.int(o.listings.by_status.sold) }}</strong></li>
            <li><span>{{ 'admin.stats.listingRemoved' | t }}</span><strong>{{ fmt.int(o.listings.by_status.removed) }}</strong></li>
            <li><span>{{ 'admin.stats.avgListingPrice' | t }}</span><strong>{{ o.listings.avg_price === null ? '—' : (o.listings.avg_price | price: o.currency) }}</strong></li>
          </ul>
        </section>
        <section class="card">
          <h3>{{ 'admin.stats.engagement' | t }}</h3>
          <ul class="rows">
            <li><span>{{ 'admin.stats.conversations' | t }}</span><strong>{{ fmt.int(o.engagement.conversations) }}</strong></li>
            <li><span>{{ 'admin.stats.reviewCount' | t }}</span><strong>{{ fmt.int(o.reviews.count) }}</strong></li>
            <li><span>{{ 'admin.stats.avgRating' | t }}</span><strong>{{ fmt.decimal(o.reviews.avg_rating) }}</strong></li>
            <li><span>{{ 'admin.stats.noShows' | t }}</span><strong>{{ fmt.int(o.reviews.no_show_count) }}</strong></li>
          </ul>
        </section>
        <section class="card">
          <h3>{{ 'admin.stats.moderation' | t }}</h3>
          <ul class="rows">
            <li><span>{{ 'admin.navReports' | t }}</span><strong>{{ fmt.int(o.moderation.new_listing_reports) }}</strong></li>
            <li><span>{{ 'admin.navChatReports' | t }}</span><strong>{{ fmt.int(o.moderation.new_chat_reports) }}</strong></li>
            <li *ngFor="let r of o.moderation.report_reasons">
              <span class="indent">{{ reportReasonLabel(r.reason) }}</span><strong>{{ fmt.int(r.count) }}</strong>
            </li>
          </ul>
        </section>
        <section class="card">
          <h3>{{ 'admin.groupAds' | t }}</h3>
          <ul class="rows">
            <li><span>{{ 'admin.stats.activeAds' | t }}</span><strong>{{ fmt.int(o.ads.active) }}</strong></li>
            <li><span>{{ 'admin.stats.adViews' | t }}</span><strong>{{ fmt.int(o.ads.views) }}</strong></li>
            <li><span>{{ 'admin.stats.adClicks' | t }}</span><strong>{{ fmt.int(o.ads.clicks) }}</strong></li>
            <li><span>{{ 'admin.stats.adCtr' | t }}</span><strong>{{ fmt.percent(o.ads.ctr) }}</strong></li>
          </ul>
          <p class="card-note">{{ 'admin.stats.adsLifetimeNote' | t }}</p>
        </section>
      </div>

      <section class="card">
        <div class="card-head">
          <h3>{{ 'admin.stats.topSchools' | t }}</h3>
          <a class="more" regionLink="/admin/stats/academics" [queryParams]="{ days: days }">{{ 'admin.stats.seeAcademics' | t }} &rarr;</a>
        </div>
        <div class="table-container" *ngIf="o.top_schools.length; else noData">
          <table class="admin-table compact">
            <thead>
              <tr>
                <th>{{ 'admin.colSchool' | t }}</th>
                <th class="num">{{ 'admin.stats.completedTransactions' | t }}</th>
                <th class="num">{{ 'admin.stats.gmv' | t }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let s of o.top_schools">
                <td>{{ s.name }}</td>
                <td class="num">{{ fmt.int(s.completed_orders) }}</td>
                <td class="num">{{ s.gmv | price: o.currency }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <ng-template #noData><div class="empty-note">{{ 'common.noData' | t }}</div></ng-template>
  `,
  styles: [STATS_PAGE_STYLES, `
    .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .more { font-size: var(--text-sm); color: var(--accent); text-decoration: none; white-space: nowrap; }
    .more:hover { text-decoration: underline; }
  `],
})
export class AdminStatsDashboardComponent {
  private stats = inject(AdminStatsService);
  private i18n = inject(I18nService);
  private regionService = inject(RegionService);
  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private period = inject(StatsPeriodMemory);

  readonly fmt = new StatsFormat(this.i18n);

  days: StatsDays = this.period.resolve(this.route.snapshot.queryParamMap.get('days'));

  overview: AdminStatsOverview | null = null;
  trend: TrendPoint[] = [];
  /** Today's chart is split by hour; the others by day. */
  hourly = false;
  loadingOverview = true;
  /** Why the last load failed, shown with a retry in place of the section. */
  loadError = '';

  private sub?: Subscription;

  constructor() {
    // Every figure belongs to one region, so a region switch reloads all of it.
    effect(() => {
      this.regionService.region();
      untracked(() => this.load());
    });
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
  }

  regionName(): string {
    return this.regionService.currentRegionObj()?.localized_name ?? this.region();
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

  cancelReasonLabel(reason: string): string {
    if (!reason) return this.i18n.t('admin.stats.reasonUnspecified');
    const key = `order.cancel_reason.${reason}`;
    const text = this.i18n.t(key);
    return text === key ? reason : text;
  }

  reportReasonLabel(reason: string): string {
    const key = REPORT_REASON_KEYS[reason];
    return key ? this.i18n.t(key) : reason;
  }

  private region(): string {
    return this.regionService.region().toUpperCase();
  }

  load() {
    this.sub?.unsubscribe();
    this.loadingOverview = true;
    this.loadError = '';
    const region = this.region();
    this.sub = forkJoin({
      overview: this.stats.getOverview(region, this.days),
      series: this.stats.getTimeseries(region, this.days),
    }).subscribe({
      next: ({ overview, series }) => {
        this.overview = overview;
        this.trend = series.series.map(d => ({ date: d.date, bar: d.completed, line: d.orders }));
        this.hourly = series.unit === 'hour';
        this.loadingOverview = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.overview = null;
        this.loadingOverview = false;
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.cdr.markForCheck();
      },
    });
  }
}
