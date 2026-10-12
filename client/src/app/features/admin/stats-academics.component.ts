import { Component, ChangeDetectorRef, DestroyRef, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  AdminStatsBreakdown, AdminStatsService, BookScope, BreakdownDimension, BreakdownRow, BreakdownSort, StatsDays,
} from '../../core/services/admin-stats.service';
import { AdminGroupBooksComponent } from './group-books.component';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { RegionService } from '../../core/region.service';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { DropdownOption, UiDropdown } from '../../shared/ui/dropdown.component';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { AdminRankingChartComponent, RankingBar } from './ranking-chart.component';
import { AdminStatsPeriodComponent, STATS_PAGE_STYLES, StatsFormat, StatsPeriodMemory } from './stats-widgets';

const DIMENSIONS: { value: BreakdownDimension; label: string; search: string; empty: string }[] = [
  { value: 'school', label: 'admin.stats.bySchool', search: 'admin.stats.searchSchool', empty: 'admin.stats.noSchool' },
  { value: 'category', label: 'admin.stats.byCategory', search: 'admin.stats.searchCategory', empty: 'admin.stats.noCategory' },
  { value: 'course', label: 'admin.stats.byCourse', search: 'admin.stats.searchCourse', empty: '' },
  { value: 'professor', label: 'admin.stats.byProfessor', search: 'admin.stats.searchProfessor', empty: '' },
];

const SORTS: { value: BreakdownSort; label: string }[] = [
  { value: 'completed', label: 'admin.stats.completedTransactions' },
  { value: 'gmv', label: 'admin.stats.gmv' },
  { value: 'orders', label: 'admin.stats.orderCount' },
  { value: 'new_listings', label: 'admin.stats.newListings' },
  { value: 'active_listings', label: 'admin.stats.activeListings' },
];

/**
 * 學校與課程: listings and transactions grouped by school, college category,
 * course or professor, optionally inside one school. Course and professor are
 * free text sellers type, so the page says how many listings name one.
 * Opening a row (or its bar) lists the books traded in it; a school row also
 * links to that school's own breakdown, starting with its colleges.
 */
@Component({
  selector: 'app-admin-stats-academics',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiSearchBarComponent, UiPagination, PricePipe,
    AdminStatsPeriodComponent, AdminRankingChartComponent, AdminGroupBooksComponent, UiDropdown,
  ],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.navStatsAcademics' | t }}</h2>
      <admin-stats-period [days]="days" (daysChange)="onDaysChange($event)"></admin-stats-period>
    </div>
    <p class="scope-note">{{ 'admin.stats.scopeNoteShort' | t: { region: regionName() } }}</p>

    <section class="card">
      <div class="section-head-row tab-row">
        <div class="tabs" role="tablist" [attr.aria-label]="'admin.stats.groupBy' | t">
          <button
            *ngFor="let d of dimensions"
            type="button"
            role="tab"
            class="tab"
            [class.active]="d.value === by"
            [attr.aria-selected]="d.value === by"
            (click)="onByChange(d.value)"
          >{{ d.label | t }}</button>
        </div>
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
        <ui-search-bar [placeholder]="dimension.search | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
        <ui-dropdown
          *ngIf="by !== 'school'"
          [label]="'admin.colSchool' | t"
          [options]="schoolDropdown"
          [ngModel]="school === null ? '' : '' + school"
          (ngModelChange)="onSchoolChange($event ? +$event : null)"
        ></ui-dropdown>
      </div>

      <p class="card-note" *ngIf="coverage as c">
        {{ (by === 'course' ? 'admin.stats.courseCoverage' : 'admin.stats.professorCoverage') | t: c }}
      </p>
      <p class="card-note">{{ (by === 'school' ? 'admin.stats.schoolDrillNote' : 'admin.stats.expandNote') | t }}</p>

      <div *ngIf="bars.length" class="chart-block" [class.stale]="loading">
        <h4 class="chart-title">{{ 'admin.stats.rankingChartTitle' | t: { n: bars.length } }}</h4>
        <admin-ranking-chart
          [rows]="bars"
          [valueLabel]="barsLabel | t"
          [format]="barFormat"
          [integer]="barsSort !== 'gmv'"
          (barClick)="onBarClick($event)"
        ></admin-ranking-chart>
      </div>

      <ui-skeleton *ngIf="!data && loading" variant="table" [count]="5"></ui-skeleton>

      <ui-error-state *ngIf="!data && !loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>
      <div class="table-container" *ngIf="data as d" [class.stale]="loading">
        <table class="admin-table breakdown">
          <thead>
            <tr>
              <th class="toggle-col"><span class="sr-only">{{ 'admin.stats.showBooks' | t }}</span></th>
              <th class="num">{{ 'admin.stats.rank' | t }}</th>
              <th>{{ dimension.label | t }}</th>
              <th class="num">{{ 'admin.stats.completedShort' | t }}</th>
              <th class="num">{{ 'admin.stats.orderCount' | t }}</th>
              <th class="num">{{ 'admin.stats.gmv' | t }}</th>
              <th class="num">{{ 'admin.stats.newListings' | t }}</th>
              <th class="num">{{ 'admin.stats.activeListings' | t }}</th>
              <th *ngIf="by === 'school'"><span class="sr-only">{{ 'admin.stats.byCategory' | t }}</span></th>
            </tr>
          </thead>
          <tbody>
            <ng-container *ngFor="let row of d.results; let i = index">
              <tr class="group-row" [class.open]="expanded === rowKey(row)" (click)="toggle(row)">
                <td class="toggle-col">
                  <button
                    type="button"
                    class="toggle"
                    [attr.aria-expanded]="expanded === rowKey(row)"
                    [attr.aria-label]="('admin.stats.showBooks' | t) + ' ' + label(row)"
                    (click)="$event.stopPropagation(); toggle(row)"
                  ><span aria-hidden="true">&#9656;</span></button>
                </td>
                <td class="num rank" [class.top]="row.rank !== null && row.rank <= 3">{{ row.rank === null ? '—' : fmt.int(row.rank) }}</td>
                <td [class.unset]="!row.label">{{ label(row) }}</td>
                <td class="num strong">{{ fmt.int(row.completed) }}</td>
                <td class="num">{{ fmt.int(row.orders) }}</td>
                <td class="num">{{ row.gmv | price: d.currency }}</td>
                <td class="num">{{ fmt.int(row.new_listings) }}</td>
                <td class="num">{{ fmt.int(row.active_listings) }}</td>
                <td *ngIf="by === 'school'" class="nowrap">
                  <button
                    *ngIf="row.id != null"
                    type="button"
                    class="link-btn"
                    (click)="$event.stopPropagation(); drillInto(row.id!)"
                  >{{ 'admin.stats.drillCategories' | t }} &rarr;</button>
                </td>
              </tr>
              <tr *ngIf="expanded === rowKey(row)" class="detail-row">
                <td [attr.colspan]="by === 'school' ? 9 : 8">
                  <admin-group-books [region]="region()" [days]="days" [scope]="expandedScope!" [name]="label(row)"></admin-group-books>
                </td>
              </tr>
            </ng-container>
            <tr *ngIf="d.results.length === 0">
              <td [attr.colspan]="by === 'school' ? 9 : 8" class="empty-note">{{ (q ? 'common.noMatches' : 'common.noData') | t }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
    </section>
  `,
  styles: [STATS_PAGE_STYLES, `
    .tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
    /* The sort sits at the tab row's end: the row takes over the tabs' rule,
       and the active tab's underline still overlaps it by its -1px margin. */
    .section-head-row.tab-row { align-items: flex-end; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
    .tab-row .tabs { margin-bottom: 0; border-bottom: none; }
    .tab-row ui-dropdown { margin-bottom: 6px; }
    .tab {
      appearance: none; background: none; border: none; cursor: pointer;
      padding: 8px 14px; margin-bottom: -1px; font: inherit; font-size: var(--text-sm);
      color: var(--muted); border-bottom: 2px solid transparent;
    }
    .tab:hover { color: var(--ink); }
    .tab.active { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .admin-table.breakdown { min-width: 720px; }
    .unset { color: var(--muted); font-style: italic; }
    .group-row { cursor: pointer; }
    .group-row:hover, .group-row.open { background: var(--paper-warm); }
    .toggle-col { width: 32px; padding-right: 0 !important; }
    .toggle {
      appearance: none; border: none; background: none; cursor: pointer; color: var(--muted);
      width: 24px; height: 24px; border-radius: 4px; font-size: 12px; line-height: 1;
      transition: transform 0.15s;
    }
    .toggle:hover { color: var(--ink); background: var(--line); }
    .toggle:focus-visible { outline: 2px solid var(--accent); }
    .toggle[aria-expanded="true"] { transform: rotate(90deg); color: var(--ink); }
    .detail-row > td { background: var(--paper-warm); padding-top: 0 !important; }
    .link-btn { appearance: none; border: none; background: none; padding: 0; cursor: pointer; font: inherit; font-size: var(--text-sm); color: var(--accent); }
    .link-btn:hover { text-decoration: underline; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
})
export class AdminStatsAcademicsComponent {
  private stats = inject(AdminStatsService);
  private i18n = inject(I18nService);
  private regionService = inject(RegionService);
  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private period = inject(StatsPeriodMemory);
  private price = new PricePipe();

  readonly fmt = new StatsFormat(this.i18n);
  readonly dimensions = DIMENSIONS;
  readonly sorts = SORTS;

  days: StatsDays;
  by: BreakdownDimension;
  school: number | null;
  sort: BreakdownSort;
  q: string;
  page: number;
  pageSize = 20;

  data: AdminStatsBreakdown | null = null;
  total = 0;
  loading = true;
  /** Why the last load failed, shown with a retry in place of the section. */
  loadError = '';
  schoolOptions: { id: number; label: string; keywords?: string[] }[] = [];
  /** Built when the schools load, not per check: the list is long and searchable. */
  schoolDropdown: DropdownOption[] = [];

  /** The open row, and the book filter it stands for (a stable object for the child's input). */
  expanded: string | null = null;
  expandedScope: BookScope | null = null;

  /** The chart describes the rows it was built from, not a sort still loading. */
  bars: RankingBar[] = [];
  barsSort: BreakdownSort = 'completed';
  private barsCurrency = '';
  readonly barFormat = (value: number) =>
    this.barsSort === 'gmv' ? this.price.transform(value, this.barsCurrency) : this.fmt.int(value);

  private sub?: Subscription;
  private schoolsSub?: Subscription;

  constructor() {
    const qp = this.route.snapshot.queryParamMap;
    this.days = this.period.resolve(qp.get('days'));
    const by = qp.get('by') as BreakdownDimension;
    this.by = DIMENSIONS.some(d => d.value === by) ? by : 'school';
    const sort = qp.get('sort') as BreakdownSort;
    this.sort = SORTS.some(s => s.value === sort) ? sort : 'completed';
    this.school = Number(qp.get('school')) || null;
    this.q = qp.get('q') ?? '';
    this.page = Math.max(1, Number(qp.get('page')) || 1);

    effect(() => {
      this.regionService.region();
      untracked(() => {
        this.loadSchools();
        this.load();
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.sub?.unsubscribe();
      this.schoolsSub?.unsubscribe();
    });
  }

  get dimension() {
    return DIMENSIONS.find(d => d.value === this.by)!;
  }

  get sortOptions(): DropdownOption[] {
    return SORTS.map(s => ({ value: s.value, label: this.i18n.t(s.label) }));
  }

  get barsLabel(): string {
    return SORTS.find(s => s.value === this.barsSort)!.label;
  }

  /** "12 / 40 (30%)" for course and professor, which sellers may leave blank. */
  get coverage(): Record<string, string> | null {
    const s = this.data?.summary;
    if (!s || s.listings === undefined || this.data?.by !== this.by) return null;
    const filled = s.listings_with_value ?? 0;
    return {
      filled: this.fmt.int(filled),
      total: this.fmt.int(s.listings),
      share: this.fmt.percent(s.listings ? filled / s.listings : null),
    };
  }

  regionName(): string {
    return this.regionService.currentRegionObj()?.localized_name ?? this.region();
  }

  label(row: BreakdownRow): string {
    if (row.label) return row.label;
    return this.dimension.empty ? this.i18n.t(this.dimension.empty) : '—';
  }

  onDaysChange(days: StatsDays) {
    this.days = days;
    this.period.days.set(days);
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onByChange(by: BreakdownDimension) {
    if (by === this.by) return;
    this.by = by;
    this.q = '';
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onSchoolChange(school: number | null) {
    this.school = school;
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onSortChange(sort: BreakdownSort) {
    this.sort = sort;
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onSearch(q: string) {
    this.q = q.trim();
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onPageChange(page: number) {
    this.page = page;
    this.syncUrl();
    this.load();
  }

  /** A bar opens its row's books; the bar's id is the row's index on this page. */
  onBarClick(bar: RankingBar) {
    const row = bar.id != null ? this.data?.results[bar.id] : undefined;
    if (!row) return;
    if (this.expanded !== this.rowKey(row)) this.toggle(row);
    requestAnimationFrame(() =>
      document.querySelector('app-admin-stats-academics .detail-row')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }

  rowKey(row: BreakdownRow): string {
    return `${this.by}:${row.id ?? row.key ?? 'none'}`;
  }

  toggle(row: BreakdownRow) {
    const key = this.rowKey(row);
    if (this.expanded === key) {
      this.expanded = null;
      this.expandedScope = null;
      return;
    }
    this.expanded = key;
    this.expandedScope = this.scopeOf(row);
  }

  private scopeOf(row: BreakdownRow): BookScope {
    const school = this.by === 'school' ? undefined : this.school;
    switch (this.by) {
      case 'school': return { school: row.id ?? 'none' };
      case 'category': return { school, category: row.id ?? 'none' };
      case 'course': return { school, course: row.key };
      case 'professor': return { school, professor: row.key };
    }
  }

  /** A school's own breakdown starts with its college categories. */
  drillInto(school: number) {
    this.school = school;
    this.by = 'category';
    this.q = '';
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  region(): string {
    return this.regionService.region().toUpperCase();
  }

  private syncUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        days: this.days,
        by: this.by === 'school' ? null : this.by,
        school: this.by !== 'school' && this.school ? this.school : null,
        sort: this.sort === 'completed' ? null : this.sort,
        q: this.q || null,
        page: this.page > 1 ? this.page : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Every school with any listing, for the filter — independent of the period. */
  private loadSchools() {
    this.schoolsSub?.unsubscribe();
    this.schoolsSub = this.stats
      .getBreakdown({ region: this.region(), days: 0, by: 'school', sort: 'active_listings', page_size: 100 })
      .subscribe({
        next: (res) => {
          this.schoolOptions = res.results
            .filter((r): r is BreakdownRow & { id: number } => r.id != null)
            .map(r => ({ id: r.id, label: r.label, keywords: r.keywords }))
            .sort((a, b) => a.label.localeCompare(b.label, this.i18n.lang()));
          this.schoolDropdown = [
            { value: '', label: this.i18n.t('admin.stats.allSchools') },
            ...this.schoolOptions.map(o => ({ value: String(o.id), label: o.label, keywords: o.keywords })),
          ];
          this.cdr.markForCheck();
        },
        error: () => { this.schoolOptions = []; },
      });
  }

  load() {
    this.sub?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    const by = this.by;
    this.sub = this.stats
      .getBreakdown({
        region: this.region(),
        days: this.days,
        by,
        sort: this.sort,
        school: by !== 'school' ? this.school : null,
        q: this.q,
        page: this.page,
        page_size: this.pageSize,
      })
      .subscribe({
        next: (res) => {
          this.data = res;
          this.total = res.count;
          this.barsSort = res.sort;
          this.barsCurrency = res.currency;
          this.bars = res.results
            .filter(r => r[res.sort] > 0)
            .slice(0, 10)
            .map((r, i) => ({ id: i, label: this.label(r), value: r[res.sort] }));
          this.expanded = null;
          this.expandedScope = null;
          this.loading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.data = null;
          this.bars = [];
          this.expanded = null;
          this.total = 0;
          this.loading = false;
          this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
          this.cdr.markForCheck();
        },
      });
  }
}
