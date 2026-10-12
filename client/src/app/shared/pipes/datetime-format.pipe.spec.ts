import { describe, expect, it } from 'vitest';
import { DateTimeFormatPipe } from './datetime-format.pipe';

const pipe = new DateTimeFormatPipe();
const localOffset = (d: Date) => {
  const m = -d.getTimezoneOffset();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
};

describe('DateTimeFormatPipe', () => {
  it('labels the shown local time with the local offset, whatever offset the API used', () => {
    for (const iso of ['2026-10-13T04:30:00.000Z', '2026-10-13T12:30:00+08:00']) {
      const d = new Date(iso);
      const out = pipe.transform(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      expect(out).toBe(
        `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${localOffset(d)})`,
      );
    }
    // Same instant, two spellings: one display.
    expect(pipe.transform('2026-10-13T04:30:00Z')).toBe(pipe.transform('2026-10-13T12:30:00+08:00'));
  });

  it('keeps date-only values date-only, and passes junk through', () => {
    expect(pipe.transform('2026-07-29')).toMatch(/^2026\/07\/(28|29|30)$/);
    expect(pipe.transform('')).toBe('');
    expect(pipe.transform('not a date')).toBe('not a date');
  });
});
