import { AfterViewInit, Component, DestroyRef, ElementRef, Input, NgZone, OnChanges, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService, TPipe } from '../../core/i18n.service';
import { prefersReducedMotion } from '../../core/reduced-motion';
import { StatsFormat } from './stats-widgets';
import { Chart, ChartTokens, onThemeChange, readChartTokens, tooltipTheme } from './chart-theme';

export interface TrendPoint {
  /** Bucket label: a date, or an hour such as 14:00. */
  date: string;
  bar: number;
  line: number;
}

/**
 * Orders placed (line) over completed transactions (bars), drawn with
 * Chart.js. Both share one y axis: the bars are a subset of the line, so two
 * scales would let a smaller number look taller.
 *
 * A canvas cannot read CSS variables, so the colours are resolved from the
 * design tokens on this element and resolved again whenever the theme
 * changes. The canvas is also opaque to screen readers and the keyboard; the
 * data table under it carries the same numbers for both.
 */
@Component({
  selector: 'admin-trend-chart',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <div [hidden]="!hasData">
      <ul class="legend">
        <li><span class="key key-line"></span>{{ lineLabel }} <strong>{{ fmt.int(lineTotal) }}</strong></li>
        <li><span class="key key-bar"></span>{{ barLabel }} <strong>{{ fmt.int(barTotal) }}</strong></li>
      </ul>
      <div class="canvas-box">
        <canvas #canvas role="img" [attr.aria-label]="ariaLabel"></canvas>
      </div>
      <details class="data">
        <summary>{{ 'admin.stats.showDataTable' | t }}</summary>
        <div class="table-container">
          <table class="admin-table compact">
            <thead>
              <tr>
                <th>{{ 'admin.stats.date' | t }}</th>
                <th class="num">{{ lineLabel }}</th>
                <th class="num">{{ barLabel }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let p of series">
                <td>{{ p.date }}</td>
                <td class="num">{{ fmt.int(p.line) }}</td>
                <td class="num">{{ fmt.int(p.bar) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>
    <div *ngIf="!hasData" class="empty-note">{{ 'common.noData' | t }}</div>
  `,
  styles: [`
    :host { display: block; }
    .legend { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: var(--text-sm); color: var(--ink-soft); }
    .legend li { display: flex; align-items: center; gap: 6px; }
    .legend strong { color: var(--ink); font-variant-numeric: tabular-nums; }
    .key { display: inline-block; width: 12px; }
    .key-bar { height: 10px; border-radius: 2px; background: var(--success); }
    .key-line { height: 2px; background: var(--info-ink); }
    /* Chart.js sizes the canvas to this box; it needs a definite height. */
    .canvas-box { position: relative; height: 220px; }
    .data { margin-top: 8px; font-size: var(--text-sm); }
    .data summary { cursor: pointer; color: var(--muted); width: fit-content; }
    .data .table-container { margin-top: 8px; max-height: 240px; overflow-y: auto; box-shadow: none; }
    .admin-table.compact { min-width: 0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class AdminTrendChartComponent implements AfterViewInit, OnChanges {
  private host = inject(ElementRef<HTMLElement>);
  private zone = inject(NgZone);
  readonly fmt = new StatsFormat(inject(I18nService));

  @Input() series: TrendPoint[] = [];
  @Input() barLabel = '';
  @Input() lineLabel = '';

  @ViewChild('canvas', { static: true }) canvas!: ElementRef<HTMLCanvasElement>;

  private chart?: Chart<'bar' | 'line', number[], string>;
  /** Read by the dataset colour functions; see onThemeChange. */
  private tokens!: ChartTokens;

  constructor() {
    onThemeChange(() => this.recolor());
    inject(DestroyRef).onDestroy(() => this.chart?.destroy());
  }

  get hasData(): boolean {
    return this.series.some(p => p.bar > 0 || p.line > 0);
  }

  get barTotal(): number {
    return this.series.reduce((sum, p) => sum + p.bar, 0);
  }

  get lineTotal(): number {
    return this.series.reduce((sum, p) => sum + p.line, 0);
  }

  get ariaLabel(): string {
    return `${this.lineLabel} ${this.lineTotal}, ${this.barLabel} ${this.barTotal}`;
  }

  ngAfterViewInit() {
    this.zone.runOutsideAngular(() => this.create());
  }

  ngOnChanges() {
    if (!this.chart) return;
    const c = this.chart;
    c.data.labels = this.series.map(p => p.date);
    c.data.datasets[0].label = this.lineLabel;
    c.data.datasets[0].data = this.series.map(p => p.line);
    c.data.datasets[1].label = this.barLabel;
    c.data.datasets[1].data = this.series.map(p => p.bar);
    this.zone.runOutsideAngular(() => c.update());
  }

  private create() {
    this.tokens = readChartTokens(this.host.nativeElement);
    this.chart = new Chart<'bar' | 'line', number[], string>(this.canvas.nativeElement, {
      type: 'bar',
      data: {
        labels: this.series.map(pt => pt.date),
        datasets: [
          {
            type: 'line',
            label: this.lineLabel,
            data: this.series.map(pt => pt.line),
            borderColor: () => this.tokens.info,
            backgroundColor: () => this.tokens.info,
            pointHoverBorderColor: () => this.tokens.tipBg,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHitRadius: 8,
            // Straight segments: these are whole counts per bucket, and a curve
            // between them suggests values in between that never happened.
            tension: 0,
            order: 0, // drawn over the bars
          },
          {
            type: 'bar',
            label: this.barLabel,
            data: this.series.map(pt => pt.bar),
            backgroundColor: () => this.tokens.success,
            borderRadius: 2,
            categoryPercentage: 0.8,
            barPercentage: 0.9,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: prefersReducedMotion() ? false : { duration: 250 },
        // Anywhere in a column picks that day; the 2px line alone is too thin to aim at.
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { display: false },
            ticks: { autoSkip: true, maxTicksLimit: 8, maxRotation: 0 },
          },
          y: {
            beginAtZero: true,
            ticks: { precision: 0, maxTicksLimit: 5 },
          },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}  ${this.fmt.int(ctx.parsed.y)}`,
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

  /** Axis and tooltip colours; the datasets read `tokens` themselves. */
  private applyTheme() {
    const t = this.tokens;
    const c = this.chart!;
    const font = { family: t.font, size: 12 };
    const { x, y } = c.options.scales as any;
    Object.assign(x.ticks, { color: t.muted, font });
    Object.assign(y.ticks, { color: t.muted, font });
    y.grid = { color: t.grid };
    x.border = { color: t.grid };
    y.border = { display: false };
    Object.assign(c.options.plugins!.tooltip!, tooltipTheme(t));
  }
}
