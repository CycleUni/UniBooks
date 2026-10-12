import { effect, inject } from '@angular/core';
import {
  BarController, BarElement, CategoryScale, Chart, LineController, LineElement, LinearScale, PointElement, Tooltip,
} from 'chart.js';
import type { TooltipOptions } from 'chart.js';
import { ThemeService } from '../../core/services/theme.service';

/**
 * What the admin statistics charts share: the Chart.js parts they draw with,
 * the design tokens a canvas needs handed to it, and a redraw on theme change.
 */

// Only what these charts draw, so the rest of Chart.js stays out of the bundle.
Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip);

export { Chart };

export interface ChartTokens {
  text: string;
  muted: string;
  grid: string;
  surface: string;
  tipBg: string;
  tipBorder: string;
  success: string;
  info: string;
  warn: string;
  danger: string;
  font: string;
}

/**
 * The design tokens, as they currently resolve on `el`. A canvas cannot read
 * CSS variables, so every colour it paints has to come through here.
 */
export function readChartTokens(el: HTMLElement): ChartTokens {
  const css = getComputedStyle(el);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    text: token('--ink', '#1a1a1a'),
    muted: token('--muted', '#6b6b6b'),
    grid: token('--line', '#e5e5e5'),
    surface: token('--surface-card', '#ffffff'),
    tipBg: token('--surface-raised', '#ffffff'),
    tipBorder: token('--surface-raised-border', token('--line-strong', '#cccccc')),
    success: token('--success', '#2E7D57'),
    info: token('--info-ink', '#1D4ED8'),
    warn: token('--warn-ink', '#7A3A1F'),
    danger: token('--danger', '#B3261E'),
    font: css.fontFamily || 'sans-serif',
  };
}

/** Tooltip look shared by every chart, in the current theme. */
export function tooltipTheme(t: ChartTokens): Partial<TooltipOptions<any>> {
  const font = { family: t.font, size: 12 };
  return {
    backgroundColor: t.tipBg,
    borderColor: t.tipBorder,
    borderWidth: 1,
    titleColor: t.text,
    bodyColor: t.text,
    titleFont: { ...font, weight: 'bold' },
    bodyFont: font,
    padding: 10,
    boxPadding: 4,
    usePointStyle: true,
  };
}

/**
 * Calls `redraw` after every theme change. Must run in an injection context
 * (a constructor). ThemeService writes data-theme in its own effect, so the
 * new token values are only on the page a frame later.
 *
 * Colours a chart paints should be functions reading state that `redraw`
 * refreshes, not values assigned to the dataset: Chart.js caches resolved bar
 * styles between updates, and an assigned colour can stay on the old theme.
 */
export function onThemeChange(redraw: () => void): void {
  const theme = inject(ThemeService);
  effect(() => {
    theme.resolved();
    requestAnimationFrame(redraw);
  });
}
