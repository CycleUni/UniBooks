import {
  AfterViewInit, Component, DestroyRef, ElementRef, EventEmitter, Input, NgZone, OnChanges, Output, ViewChild, inject,
} from '@angular/core';
import { prefersReducedMotion } from '../../core/reduced-motion';
import type { ChartEvent } from 'chart.js';
import { Chart, ChartTokens, onThemeChange, readChartTokens, tooltipTheme } from './chart-theme';

export interface RankingBar {
  /** Target of a click; bars without one (e.g. a course name) are not links. */
  id?: number | null;
  label: string;
  value: number;
}

/**
 * Longest title shown on the axis, by chart width; the tooltip carries the
 * full one. Narrow screens keep more room for the bars themselves.
 */
const AXIS_LABEL_MAX = { wide: 24, narrow: 12 };
const NARROW_BELOW_PX = 480;

/**
 * Horizontal bars for the top rows of a ranking (books, schools, courses…).
 * Pointing at a bar shows the full label and its figure; clicking one that
 * has an id emits it so the page can open it. Every page pairs the chart with
 * a table holding the same numbers, for keyboard and screen-reader users.
 */
@Component({
  selector: 'admin-ranking-chart',
  standalone: true,
  template: `
    <div class="canvas-box" [style.height.px]="height">
      <canvas #canvas role="img" [attr.aria-label]="ariaLabel"></canvas>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .canvas-box { position: relative; }
  `],
})
export class AdminRankingChartComponent implements AfterViewInit, OnChanges {
  private host = inject(ElementRef<HTMLElement>);
  private zone = inject(NgZone);

  @Input({ required: true }) rows: RankingBar[] = [];
  /** Name of the figure the bars measure, e.g. 成交次數. */
  @Input() valueLabel = '';
  /** Formats a value for the tooltip and the axis (count or money). */
  @Input() format: (value: number) => string = v => String(v);
  /** Whether values are whole counts, so the axis never shows 0.5. */
  @Input() integer = true;

  @Output() barClick = new EventEmitter<RankingBar>();

  @ViewChild('canvas', { static: true }) canvas!: ElementRef<HTMLCanvasElement>;

  private chart?: Chart<'bar', number[], string>;
  private tokens!: ChartTokens;

  constructor() {
    onThemeChange(() => this.recolor());
    inject(DestroyRef).onDestroy(() => this.chart?.destroy());
  }

  get height(): number {
    return Math.max(1, this.rows.length) * 28 + 24;
  }

  get ariaLabel(): string {
    return this.rows.map(r => `${r.label} ${this.format(r.value)}`).join(', ');
  }

  ngAfterViewInit() {
    this.zone.runOutsideAngular(() => this.create());
  }

  ngOnChanges() {
    if (!this.chart) return;
    const c = this.chart;
    c.data.labels = this.axisLabels();
    c.data.datasets[0].label = this.valueLabel;
    c.data.datasets[0].data = this.rows.map(r => r.value);
    (c.options.scales as any).x.ticks.precision = this.integer ? 0 : undefined;
    // The box height changes with the row count; resize after Angular applies it.
    this.zone.runOutsideAngular(() => requestAnimationFrame(() => { c.resize(); c.update(); }));
  }

  private axisLabels(): string[] {
    const width = (this.host.nativeElement as HTMLElement).clientWidth;
    const max = width && width < NARROW_BELOW_PX ? AXIS_LABEL_MAX.narrow : AXIS_LABEL_MAX.wide;
    return this.rows.map(r => (r.label.length > max ? r.label.slice(0, max - 1) + '…' : r.label));
  }

  /** The book row under the pointer, anywhere across its line. */
  private rowAt(event: ChartEvent): RankingBar | undefined {
    if (!this.chart || !event.native) return undefined;
    const hit = this.chart.getElementsAtEventForMode(event.native, 'index', { axis: 'y', intersect: false }, false);
    return hit.length ? this.rows[hit[0].index] : undefined;
  }

  private create() {
    this.tokens = readChartTokens(this.host.nativeElement);
    this.chart = new Chart<'bar', number[], string>(this.canvas.nativeElement, {
      type: 'bar',
      data: {
        labels: this.axisLabels(),
        datasets: [{
          label: this.valueLabel,
          data: this.rows.map(r => r.value),
          backgroundColor: () => this.tokens.success,
          hoverBackgroundColor: () => this.tokens.info,
          borderRadius: 3,
          barThickness: 16,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: prefersReducedMotion() ? false : { duration: 250 },
        interaction: { mode: 'index', axis: 'y', intersect: false },
        // Label length depends on width; Chart.js redraws right after this.
        onResize: chart => { chart.data.labels = this.axisLabels(); },
        onHover: event => {
          const row = this.rowAt(event);
          this.canvas.nativeElement.style.cursor = row?.id != null && this.barClick.observed ? 'pointer' : 'default';
        },
        onClick: event => {
          const row = this.rowAt(event);
          if (row?.id != null) this.zone.run(() => this.barClick.emit(row));
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: this.integer ? 0 : undefined, maxTicksLimit: 5, callback: v => this.format(Number(v)) },
          },
          y: { grid: { display: false } },
        },
        plugins: {
          tooltip: {
            displayColors: false,
            callbacks: {
              // The axis label may be cut short; the tooltip names the book in full.
              title: items => this.rows[items[0].dataIndex]?.label ?? '',
              label: ctx => `${this.valueLabel}  ${this.format(ctx.parsed.x ?? 0)}`,
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
    x.grid = { color: t.grid };
    x.border = { display: false };
    y.ticks = { ...y.ticks, color: t.text, font };
    y.border = { color: t.grid };
    Object.assign(c.options.plugins!.tooltip!, tooltipTheme(t));
  }
}
