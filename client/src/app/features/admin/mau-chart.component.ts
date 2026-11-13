import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  Input,
  NgZone,
  OnChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService, TPipe } from '../../core/i18n.service';
import { prefersReducedMotion } from '../../core/reduced-motion';
import { StatsFormat } from './stats-widgets';
import { Chart, ChartTokens, onThemeChange, readChartTokens, tooltipTheme } from './chart-theme';

export interface MauPoint {
  month: string;
  mau: number;
}

/**
 * Monthly Active Accounts (MAU) bar chart drawn with Chart.js.
 * Colors and tokens resolve from CSS variables and respond to theme switches.
 * Paired with a collapsible data table for keyboard and screen-reader users.
 */
@Component({
  selector: 'admin-mau-chart',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <div [hidden]="!hasData">
      <div class="canvas-box">
        <canvas #canvas role="img" [attr.aria-label]="ariaLabel"></canvas>
      </div>
      <details class="data">
        <summary>{{ 'admin.stats.showDataTable' | t }}</summary>
        <div class="table-container">
          <table class="admin-table compact">
            <thead>
              <tr>
                <th>{{ 'admin.stats.month' | t }}</th>
                <th class="num">{{ 'admin.stats.mau' | t }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let p of series">
                <td>{{ p.month }}</td>
                <td class="num">{{ fmt.int(p.mau) }}</td>
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
    .canvas-box { position: relative; height: 180px; }
    .data { margin-top: 8px; font-size: var(--text-sm); }
    .data summary { cursor: pointer; color: var(--muted); width: fit-content; }
    .data .table-container { margin-top: 8px; max-height: 200px; overflow-y: auto; box-shadow: none; }
    .admin-table.compact { min-width: 0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .empty-note { padding: 24px 0; text-align: center; color: var(--muted); font-size: var(--text-sm); }
  `],
})
export class AdminMauChartComponent implements AfterViewInit, OnChanges {
  private host = inject(ElementRef<HTMLElement>);
  private zone = inject(NgZone);
  private i18n = inject(I18nService);
  readonly fmt = new StatsFormat(this.i18n);

  @Input() series: MauPoint[] = [];

  @ViewChild('canvas', { static: true }) canvas!: ElementRef<HTMLCanvasElement>;

  private chart?: Chart<'bar', number[], string>;
  private tokens!: ChartTokens;

  constructor() {
    onThemeChange(() => this.recolor());
    inject(DestroyRef).onDestroy(() => this.chart?.destroy());
  }

  get hasData(): boolean {
    return this.series.some(p => p.mau > 0);
  }

  get ariaLabel(): string {
    return `${this.i18n.t('admin.stats.mau')} ${this.series.map(s => `${s.month}: ${s.mau}`).join(', ')}`;
  }

  ngAfterViewInit() {
    this.zone.runOutsideAngular(() => this.create());
  }

  ngOnChanges() {
    if (!this.chart) return;
    const c = this.chart;
    c.data.labels = this.series.map(p => p.month);
    c.data.datasets[0].label = this.i18n.t('admin.stats.mau');
    c.data.datasets[0].data = this.series.map(p => p.mau);
    this.zone.runOutsideAngular(() => c.update());
  }

  private create() {
    if (!this.canvas?.nativeElement) return;
    try {
      if (!this.canvas.nativeElement.getContext?.('2d')) return;
    } catch {
      return;
    }
    this.tokens = readChartTokens(this.host.nativeElement);
    this.chart = new Chart<'bar', number[], string>(this.canvas.nativeElement, {
      type: 'bar',
      data: {
        labels: this.series.map(pt => pt.month),
        datasets: [
          {
            type: 'bar',
            label: this.i18n.t('admin.stats.mau'),
            data: this.series.map(pt => pt.mau),
            backgroundColor: () => this.tokens.success,
            borderRadius: 4,
            maxBarThickness: 48,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: prefersReducedMotion() ? false : { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { display: false },
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
