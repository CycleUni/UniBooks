import {
  AfterViewInit, Component, DestroyRef, ElementRef, EventEmitter, Injectable, Input, NgZone, OnChanges, Output,
  ViewChild, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { I18nService, TPipe } from '../../core/i18n.service';
import { OrderStatusCounts, StatsDays } from '../../core/services/admin-stats.service';
import { prefersReducedMotion } from '../../core/reduced-motion';
import { DropdownOption, UiDropdown } from '../../shared/ui/dropdown.component';
import { Chart, ChartTokens, onThemeChange, readChartTokens, tooltipTheme } from './chart-theme';

/** Shared pieces of the admin statistics pages. */

export const STATS_DAYS: StatsDays[] = [1, 7, 30, 90, 365, 0];

export function parseStatsDays(raw: string | null, fallback: StatsDays = 30): StatsDays {
  const n = Number(raw);
  return raw !== null && (STATS_DAYS as number[]).includes(n) ? (n as StatsDays) : fallback;
}

/**
 * The period last chosen on any statistics page, so moving between the
 * pages through the sidebar keeps it. A `?days=` in the URL still wins.
 * In memory only: a fresh visit starts from the default.
 */
@Injectable({ providedIn: 'root' })
export class StatsPeriodMemory {
  readonly days = signal<StatsDays>(30);

  /** The period for a page: its URL's, else the remembered one. */
  resolve(raw: string | null): StatsDays {
    const days = parseStatsDays(raw, this.days());
    this.days.set(days);
    return days;
  }
}

/**
 * Card, tile and table styles every statistics page shares, so each page's
 * own `styles` holds only what is particular to it.
 */
export const STATS_PAGE_STYLES = `
  :host { display: block; }
  /* .section-head-row is global; statistics pages set their headings flush
     and keep the row tight above the scope note. */
  .section-head-row { margin-bottom: 8px; }
  .section-head-row h2, .section-head-row h3 { margin: 0; }
  .scope-note { margin: 0 0 24px; font-size: var(--text-sm); color: var(--muted); }
  .card-note { margin: -8px 0 12px; font-size: var(--text-sm); color: var(--muted); }
  .stale { opacity: 0.55; transition: opacity 0.15s; }

  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap: 12px; margin-bottom: 16px; }
  .kpi, .card { background: var(--surface-card); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow-card); }
  .kpi { padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .kpi-label { font-size: var(--text-sm); color: var(--muted); }
  .kpi-value { font-size: var(--text-xl); font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .kpi-value.warn { color: var(--danger); }
  .kpi-value.accent { color: var(--accent); }
  .kpi-sub { font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums; }

  .card { padding: 16px; margin-bottom: 16px; min-width: 0; }
  .card h3 { margin: 0 0 12px; font-size: var(--text-base); }
  /* A card title with controls beside it: the row owns the spacing. */
  .card .section-head-row h3 { margin: 0; }
  .card .table-container { box-shadow: none; }
  .grid-2, .grid-3 { display: grid; gap: 16px; margin-bottom: 16px; }
  .grid-2 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); }
  .grid-3 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
  .grid-2 .card, .grid-3 .card { margin-bottom: 0; }

  .rows { list-style: none; margin: 0; padding: 0; font-size: var(--text-sm); }
  .rows li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .rows li:last-child { border-bottom: none; }
  .rows strong { font-variant-numeric: tabular-nums; }
  .rows strong.warn { color: var(--danger); }
  .rows .indent { padding-left: 12px; color: var(--muted); }

  .admin-filters ui-dropdown { min-width: 180px; }
  .chart-block { margin-bottom: 16px; }
  .chart-title { margin: 0 0 8px; font-size: var(--text-sm); font-weight: 600; color: var(--ink-soft); }

  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .nowrap { white-space: nowrap; }
  .strong { font-weight: 700; }
  .rank { color: var(--muted); }
  .rank.top { color: var(--accent); font-weight: 700; }
  .admin-table.compact { min-width: 0; }
  .book { display: flex; align-items: center; gap: 10px; min-width: 220px; }
  .thumb { display: inline-block; width: 30px; height: 40px; flex-shrink: 0; object-fit: cover; border-radius: 3px; border: 1px solid var(--line); background: var(--paper-warm); }
  .book-text { display: flex; flex-direction: column; min-width: 0; }
  .book-title { font-weight: 600; color: var(--ink); }
  .book-meta { font-size: var(--text-xs); color: var(--muted); }
`;

/** Number formatting in the viewer's language; null reads as an em dash. */
export class StatsFormat {
  constructor(private i18n: I18nService) {}

  int(value: number | null | undefined): string {
    return value == null ? '—' : new Intl.NumberFormat(this.i18n.lang()).format(value);
  }

  decimal(value: number | null | undefined): string {
    return value == null
      ? '—'
      : new Intl.NumberFormat(this.i18n.lang(), { maximumFractionDigits: 1 }).format(value);
  }

  percent(value: number | null | undefined): string {
    return value == null
      ? '—'
      : new Intl.NumberFormat(this.i18n.lang(), { style: 'percent', maximumFractionDigits: 1 }).format(value);
  }
}

/**
 * The period picker every statistics page puts beside its title: the site's
 * own dropdown, compact and label-less (the title row is its context), with
 * the name kept for screen readers.
 */
@Component({
  selector: 'admin-stats-period',
  standalone: true,
  imports: [FormsModule, TPipe, UiDropdown],
  template: `
    <ui-dropdown
      [compact]="true"
      [searchable]="false"
      [options]="options"
      [triggerAriaLabel]="'admin.stats.period' | t"
      [ngModel]="'' + days"
      (ngModelChange)="onChange($event)"
    ></ui-dropdown>
  `,
  styles: [`
    :host { display: block; min-width: 150px; }
  `],
})
export class AdminStatsPeriodComponent {
  private i18n = inject(I18nService);

  @Input() days: StatsDays = 30;
  @Output() daysChange = new EventEmitter<StatsDays>();

  get options(): DropdownOption[] {
    return [
      { value: '1', label: this.i18n.t('admin.stats.periodToday') },
      { value: '7', label: this.i18n.t('admin.stats.period7') },
      { value: '30', label: this.i18n.t('admin.stats.period30') },
      { value: '90', label: this.i18n.t('admin.stats.period90') },
      { value: '365', label: this.i18n.t('admin.stats.period365') },
      { value: '0', label: this.i18n.t('admin.stats.periodAll') },
    ];
  }

  onChange(value: string) {
    this.daysChange.emit(parseStatsDays(value));
  }
}

const STATUS_ORDER: (keyof OrderStatusCounts)[] = ['pending', 'accepted', 'handed_over', 'completed', 'cancelled'];

/** Token each status is painted with; the legend swatches use the same ones. */
const STATUS_TOKEN: Record<keyof OrderStatusCounts, keyof ChartTokens> = {
  pending: 'muted',
  accepted: 'info',
  handed_over: 'warn',
  completed: 'success',
  cancelled: 'danger',
};

/**
 * Orders by status as one stacked bar (Chart.js), with a legend that carries
 * every number — the legend is also what screen readers and keyboards get,
 * since the canvas is opaque to both. Pointing at a segment shows its count
 * and share.
 */
@Component({
  selector: 'admin-status-bar',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <div [hidden]="total === 0">
      <div class="canvas-box">
        <canvas #canvas role="img" [attr.aria-label]="summary()"></canvas>
      </div>
      <ul class="legend">
        <li *ngFor="let status of statuses">
          <span [class]="'swatch s-' + status"></span>
          {{ 'order.status.' + status | t }}
          <strong>{{ fmt.int(counts[status]) }}</strong>
          <span class="pct">{{ fmt.percent(total ? counts[status] / total : null) }}</span>
        </li>
      </ul>
    </div>
    <div *ngIf="total === 0" class="empty-note">{{ 'common.noData' | t }}</div>
  `,
  styles: [`
    :host { display: block; }
    /* Taller than the 16px bar so the tooltip, drawn inside the canvas, fits beside it. */
    .canvas-box { position: relative; height: 44px; }
    .legend { list-style: none; padding: 0; margin: 4px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px 16px; font-size: var(--text-sm); color: var(--ink-soft); }
    .legend li { display: flex; align-items: center; gap: 6px; }
    .legend strong { margin-left: auto; color: var(--ink); font-variant-numeric: tabular-nums; }
    .pct { color: var(--muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; min-width: 3.5em; text-align: right; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
    .s-pending { background: var(--muted); }
    .s-accepted { background: var(--info-ink); }
    .s-handed_over { background: var(--warn-ink); }
    .s-completed { background: var(--success); }
    .s-cancelled { background: var(--danger); }
  `],
})
export class AdminStatusBarComponent implements AfterViewInit, OnChanges {
  private i18n = inject(I18nService);
  private host = inject(ElementRef<HTMLElement>);
  private zone = inject(NgZone);
  readonly fmt = new StatsFormat(this.i18n);
  readonly statuses = STATUS_ORDER;

  @Input({ required: true }) counts!: OrderStatusCounts;

  @ViewChild('canvas', { static: true }) canvas!: ElementRef<HTMLCanvasElement>;

  private chart?: Chart<'bar', number[], string>;
  /** Read by the segment colour functions; see onThemeChange. */
  private tokens!: ChartTokens;

  constructor() {
    onThemeChange(() => this.recolor());
    inject(DestroyRef).onDestroy(() => this.chart?.destroy());
  }

  get total(): number {
    return STATUS_ORDER.reduce((sum, s) => sum + (this.counts?.[s] ?? 0), 0);
  }

  summary(): string {
    return STATUS_ORDER.filter(s => this.counts[s] > 0)
      .map(s => `${this.i18n.t('order.status.' + s)} ${this.fmt.int(this.counts[s])}`)
      .join(', ');
  }

  ngAfterViewInit() {
    this.zone.runOutsideAngular(() => this.create());
  }

  ngOnChanges() {
    if (!this.chart) return;
    const c = this.chart;
    c.data.datasets.forEach((d, i) => {
      d.label = this.i18n.t('order.status.' + STATUS_ORDER[i]);
      d.data = [this.counts[STATUS_ORDER[i]]];
    });
    (c.options.scales as any).x.max = this.total || 1;
    this.zone.runOutsideAngular(() => c.update());
  }

  private create() {
    this.tokens = readChartTokens(this.host.nativeElement);
    this.chart = new Chart<'bar', number[], string>(this.canvas.nativeElement, {
      type: 'bar',
      data: {
        labels: [''],
        datasets: STATUS_ORDER.map(status => ({
          label: this.i18n.t('order.status.' + status),
          data: [this.counts[status]],
          backgroundColor: () => this.tokens[STATUS_TOKEN[status]],
          // A hairline in the card colour keeps neighbouring segments apart.
          borderColor: () => this.tokens.surface,
          borderWidth: { left: 1, right: 1 },
          borderSkipped: false,
          borderRadius: 3,
          barThickness: 16,
        })),
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: prefersReducedMotion() ? false : { duration: 250 },
        interaction: { mode: 'nearest', axis: 'x', intersect: true },
        layout: { padding: 0 },
        scales: {
          x: { stacked: true, display: false, min: 0, max: this.total || 1 },
          y: { stacked: true, display: false },
        },
        plugins: {
          tooltip: {
            yAlign: 'center',
            displayColors: true,
            callbacks: {
              title: () => '',
              label: ctx => {
                const n = ctx.parsed.x ?? 0;
                return ` ${ctx.dataset.label}  ${this.fmt.int(n)} (${this.fmt.percent(this.total ? n / this.total : null)})`;
              },
            },
          },
        },
      },
    });
    this.applyTheme();
    this.chart.update('none');
  }

  private recolor() {
    if (!this.chart) return;
    this.tokens = readChartTokens(this.host.nativeElement);
    this.applyTheme();
    this.zone.runOutsideAngular(() => this.chart!.update('none'));
  }

  private applyTheme() {
    Object.assign(this.chart!.options.plugins!.tooltip!, tooltipTheme(this.tokens));
  }
}
