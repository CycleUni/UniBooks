import { Component, ChangeDetectorRef, DestroyRef, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  AcademicTerm, AdminStatsGrowth, AdminStatsRetention, AdminStatsService, DurationFigure, RetentionRole, StatsDays,
} from '../../core/services/admin-stats.service';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { RegionService } from '../../core/region.service';
import { DropdownOption, UiDropdown } from '../../shared/ui/dropdown.component';
import { AdminStatsPeriodComponent, STATS_PAGE_STYLES, StatsFormat, StatsPeriodMemory } from './stats-widgets';

const ROLES: RetentionRole[] = ['all', 'buyer', 'seller'];

/**
 * 成長與留存: marketplace liquidity and matching speed for the period, and
 * semester cohorts. Search, page-view and traffic-source figures are not
 * here — the database never sees them; they live in Google Analytics.
 */
@Component({
  selector: 'app-admin-stats-growth',
  standalone: true,
  imports: [CommonModule, FormsModule, TPipe, UiSkeleton, UiErrorState, AdminStatsPeriodComponent, UiDropdown],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.navStatsGrowth' | t }}</h2>
      <admin-stats-period [days]="days" (daysChange)="onDaysChange($event)"></admin-stats-period>
    </div>
    <p class="scope-note">{{ 'admin.stats.scopeNoteShort' | t: { region: regionName() } }} {{ 'admin.stats.gaNote' | t }}</p>

    <ui-skeleton *ngIf="!growth && loading" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state *ngIf="!growth && !loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>

    <ng-container *ngIf="growth as g">
      <section class="kpi-grid" [class.stale]="loading">
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.sellThrough' | t }}</span>
          <span class="kpi-value">{{ fmt.percent(g.sell_through.rate) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.sellThroughSub' | t: { sold: fmt.int(g.sell_through.sold), listings: fmt.int(g.sell_through.listings) } }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.overlapRate' | t }}</span>
          <span class="kpi-value">{{ fmt.percent(g.users.overlap_rate) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.overlapSub' | t: { both: fmt.int(g.users.both) } }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.repeatRate' | t }}</span>
          <span class="kpi-value">{{ fmt.percent(g.users.repeat_rate) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.repeatSub' | t: { n: fmt.int(g.users.repeat_buyers), buyers: fmt.int(g.users.buyers) } }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.chatToOrder' | t }}</span>
          <span class="kpi-value">{{ fmt.percent(g.chat_to_order.order_rate) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.chatToOrderSub' | t: { ordered: fmt.int(g.chat_to_order.ordered), chats: fmt.int(g.chat_to_order.chats) } }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.requestToOrder' | t }}</span>
          <span class="kpi-value">{{ fmt.percent(g.requests.order_rate) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.requestToOrderSub' | t: { ordered: fmt.int(g.requests.ordered), requests: fmt.int(g.requests.requests) } }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">{{ 'admin.stats.medianListingToSale' | t }}</span>
          <span class="kpi-value">{{ dayText(g.speed.listing_to_sale.median_days) }}</span>
          <span class="kpi-sub">{{ 'admin.stats.sampleSize' | t: { n: fmt.int(g.speed.listing_to_sale.count) } }}</span>
        </div>
      </section>

      <div class="grid-2" [class.stale]="loading">
        <section class="card">
          <h3>{{ 'admin.stats.matchSpeed' | t }}</h3>
          <p class="card-note">{{ 'admin.stats.matchSpeedNote' | t }}</p>
          <div class="table-container">
            <table class="admin-table compact">
              <thead>
                <tr>
                  <th>{{ 'admin.stats.stage' | t }}</th>
                  <th class="num">{{ 'admin.stats.median' | t }}</th>
                  <th class="num">{{ 'admin.stats.average' | t }}</th>
                  <th class="num">{{ 'admin.stats.samples' | t }}</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let s of speedRows(g)">
                  <td>{{ s.label | t }}</td>
                  <td class="num strong">{{ dayText(s.figure.median_days) }}</td>
                  <td class="num">{{ dayText(s.figure.avg_days) }}</td>
                  <td class="num">{{ fmt.int(s.figure.count) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <h3>{{ 'admin.stats.funnels' | t }}</h3>
          <h4 class="sub">{{ 'admin.stats.chatToOrder' | t }}</h4>
          <ul class="rows">
            <li><span>{{ 'admin.stats.chatsOpened' | t }}</span><strong>{{ fmt.int(g.chat_to_order.chats) }}</strong></li>
            <li><span class="indent">{{ 'admin.stats.ledToOrder' | t }}</span><strong>{{ fmt.int(g.chat_to_order.ordered) }} · {{ fmt.percent(g.chat_to_order.order_rate) }}</strong></li>
            <li><span class="indent">{{ 'admin.stats.ledToSale' | t }}</span><strong>{{ fmt.int(g.chat_to_order.completed) }} · {{ fmt.percent(g.chat_to_order.completion_rate) }}</strong></li>
          </ul>
          <p class="card-note foot" *ngIf="g.chat_to_order.undated && days !== 0">
            {{ 'admin.stats.undatedChats' | t: { n: fmt.int(g.chat_to_order.undated) } }}
          </p>
          <h4 class="sub">{{ 'admin.stats.requestToOrder' | t }}</h4>
          <ul class="rows">
            <li><span>{{ 'admin.stats.requestsMade' | t }}</span><strong>{{ fmt.int(g.requests.requests) }}</strong></li>
            <li><span class="indent">{{ 'admin.stats.notifiedCount' | t }}</span><strong>{{ fmt.int(g.requests.notified) }}</strong></li>
            <li><span class="indent">{{ 'admin.stats.requesterOrdered' | t }}</span><strong>{{ fmt.int(g.requests.ordered) }}</strong></li>
            <li><span class="indent">{{ 'admin.stats.requesterBought' | t }}</span><strong>{{ fmt.int(g.requests.bought) }}</strong></li>
          </ul>
        </section>
      </div>
    </ng-container>

    <section class="card">
      <div class="section-head-row">
        <h3>{{ 'admin.stats.retention' | t }}</h3>
        <ui-dropdown
          class="role"
          [compact]="true"
          [searchable]="false"
          [options]="roleOptions"
          [triggerAriaLabel]="'admin.stats.activeAs' | t"
          [ngModel]="role"
          (ngModelChange)="onRoleChange($event)"
        ></ui-dropdown>
      </div>
      <p class="card-note">{{ 'admin.stats.retentionNote' | t }}</p>

      <ui-skeleton *ngIf="!retention && loadingRetention" variant="table" [count]="5"></ui-skeleton>

      <ui-error-state *ngIf="!retention && !loadingRetention && retentionError" [message]="retentionError" (retry)="loadRetention()"></ui-error-state>
      <div class="table-container" *ngIf="retention as r" [class.stale]="loadingRetention">
        <table class="admin-table cohort">
          <thead>
            <tr>
              <th>{{ 'admin.stats.cohort' | t }}</th>
              <th class="num">{{ 'admin.stats.cohortSize' | t }}</th>
              <th *ngFor="let t of r.terms; let k = index" class="num">{{ 'admin.stats.termOffset' | t: { k: k } }}</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let c of r.cohorts">
              <td class="nowrap">{{ termLabel(c.term) }}</td>
              <td class="num strong">{{ fmt.int(c.size) }}</td>
              <td
                *ngFor="let t of r.terms; let k = index"
                class="num heat"
                [style.--rate]="c.size && k < c.rates.length ? c.rates[k] : null"
                [attr.title]="k < c.retained.length ? fmt.int(c.retained[k]) + ' / ' + fmt.int(c.size) : null"
              >{{ k < c.rates.length && c.size ? fmt.percent(c.rates[k]) : '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  `,
  styles: [STATS_PAGE_STYLES, `
    .sub { margin: 12px 0 4px; font-size: var(--text-sm); color: var(--ink-soft); }
    .sub:first-of-type { margin-top: 0; }
    .foot { margin: 4px 0 0; font-size: var(--text-xs); }
    .card > .section-head-row { margin-bottom: 12px; }
    .role { min-width: 150px; }
    .admin-table.cohort { min-width: 560px; }
    /* Shade by the retained share; an empty cell (a term not reached yet) stays plain. */
    .heat { background: color-mix(in srgb, var(--success) calc(var(--rate, 0) * 70%), transparent); }
  `],
})
export class AdminStatsGrowthComponent {
  private stats = inject(AdminStatsService);
  private i18n = inject(I18nService);
  private regionService = inject(RegionService);
  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private period = inject(StatsPeriodMemory);

  readonly fmt = new StatsFormat(this.i18n);
  readonly roles = ROLES;

  days: StatsDays;
  role: RetentionRole;

  growth: AdminStatsGrowth | null = null;
  loading = true;
  /** Why the last load failed, shown with a retry in place of the section. */
  loadError = '';
  retention: AdminStatsRetention | null = null;
  loadingRetention = true;
  /** Why the last load failed, shown with a retry in place of the section. */
  retentionError = '';

  private sub?: Subscription;
  private retentionSub?: Subscription;

  constructor() {
    const qp = this.route.snapshot.queryParamMap;
    this.days = this.period.resolve(qp.get('days'));
    const role = qp.get('role') as RetentionRole;
    this.role = ROLES.includes(role) ? role : 'all';

    effect(() => {
      this.regionService.region();
      untracked(() => {
        this.load();
        this.loadRetention();
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.sub?.unsubscribe();
      this.retentionSub?.unsubscribe();
    });
  }

  regionName(): string {
    return this.regionService.currentRegionObj()?.localized_name ?? this.region();
  }

  /** "2.5 days", or an em dash when there is nothing to measure. */
  dayText(value: number | null): string {
    return value === null ? '—' : this.i18n.t('admin.stats.nDays', { n: this.fmt.decimal(value) });
  }

  speedRows(g: AdminStatsGrowth): { label: string; figure: DurationFigure }[] {
    return [
      { label: 'admin.stats.listingToFirstChat', figure: g.speed.listing_to_first_chat },
      { label: 'admin.stats.listingToFirstOrder', figure: g.speed.listing_to_first_order },
      { label: 'admin.stats.listingToSale', figure: g.speed.listing_to_sale },
      { label: 'admin.stats.orderToCompletion', figure: g.speed.order_to_completion },
    ];
  }

  get roleOptions(): DropdownOption[] {
    const labels: Record<RetentionRole, string> = {
      all: 'admin.stats.roleAll', buyer: 'admin.stats.roleBuyer', seller: 'admin.stats.roleSeller',
    };
    return ROLES.map(value => ({ value, label: this.i18n.t(labels[value]) }));
  }

  /**
   * Calendar year plus season — 2026 秋季 runs August 2026 to January 2027 —
   * so terms read in order without an academic-year convention to decode.
   */
  termLabel(term: AcademicTerm): string {
    return this.i18n.t(term.season === 'autumn' ? 'admin.stats.termAutumn' : 'admin.stats.termSpring', { year: term.year });
  }

  onDaysChange(days: StatsDays) {
    this.days = days;
    this.period.days.set(days);
    this.syncUrl();
    this.load();
  }

  onRoleChange(role: RetentionRole) {
    this.role = role;
    this.syncUrl();
    this.loadRetention();
  }

  private region(): string {
    return this.regionService.region().toUpperCase();
  }

  private syncUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { days: this.days, role: this.role === 'all' ? null : this.role },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  load() {
    this.sub?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    this.sub = this.stats.getGrowth(this.region(), this.days).subscribe({
      next: (res) => {
        this.growth = res;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.growth = null;
        this.loading = false;
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.cdr.markForCheck();
      },
    });
  }

  loadRetention() {
    this.retentionSub?.unsubscribe();
    this.loadingRetention = true;
    this.retentionError = '';
    this.retentionSub = this.stats.getRetention(this.region(), this.role).subscribe({
      next: (res) => {
        this.retention = res;
        this.loadingRetention = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.retention = null;
        this.loadingRetention = false;
        this.retentionError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.cdr.markForCheck();
      },
    });
  }
}
