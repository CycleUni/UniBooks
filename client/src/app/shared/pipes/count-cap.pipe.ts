import { Pipe, PipeTransform } from '@angular/core';

export const DEFAULT_COUNT_CAP = 9999;

/**
 * Caps displayed numeric counts at a maximum threshold (default 9999),
 * appending a '+' suffix when exceeded (e.g. 10000 -> '9999+').
 *
 * Usage:
 *   {{ count | countCap }}          // 9999 -> '9999', 10000 -> '9999+'
 *   {{ count | countCap: 100 }}     // 100 -> '100', 101 -> '100+'
 *
 * Edge cases:
 * - null / undefined / '' -> ''
 * - 0 -> '0'
 * - non-numeric strings (e.g. '-') -> original value as string
 */
@Pipe({
  name: 'countCap',
  standalone: true,
  pure: true
})
export class CountCapPipe implements PipeTransform {
  transform(value: number | string | null | undefined, cap: number = DEFAULT_COUNT_CAP): string {
    if (value === null || value === undefined || value === '') {
      return '';
    }

    const num = typeof value === 'number' ? value : Number(value);
    if (isNaN(num)) {
      return String(value);
    }

    if (num > cap) {
      return `${cap}+`;
    }

    return String(num);
  }
}
