/**
 * Calendar arithmetic in a region's time zone for the admin statistics
 * (period starts, series buckets, academic terms). Timestamps are stored as UTC ISO strings, so a
 * period start is turned into the UTC instant of local midnight and rows are
 * compared as strings.
 */

/** 1 is "today" (from local midnight); 0 is all time. */
export const ALLOWED_DAYS = [1, 7, 30, 90, 365, 0];
export const DEFAULT_DAYS = 30;
export const MAX_SERIES_DAYS = 365;
const FALLBACK_TZ = 'Asia/Taipei';
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A usable IANA zone: the region's, or the project default when it is invalid. */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return FALLBACK_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return FALLBACK_TZ;
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(ms: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Milliseconds the zone is ahead of UTC at instant `ms`. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of local midnight on y-m-d in `tz`. */
export function zonedMidnight(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** YYYY-MM-DD of a UTC-midnight day number. */
function isoDay(utcMidnight: number): string {
  const d = new Date(utcMidnight);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The local calendar date of an instant, as YYYY-MM-DD. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Start of the first local day in the window, as a UTC ISO string; null for all time. */
export function periodStart(tz: string, days: number, now = Date.now()): string | null {
  if (!days) return null;
  const p = localParts(now, tz);
  const first = new Date(Date.UTC(p.year, p.month - 1, p.day) - (days - 1) * DAY_MS);
  return new Date(zonedMidnight(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate(), tz)).toISOString();
}

/**
 * The chart's buckets: hours of today up to the current one for days=1,
 * else one per local day (zero-filled, at most a year). `labels` go out as
 * each point's `date`; `keyOf` maps a stored timestamp to its label, or null
 * when it falls before the series.
 */
export class SeriesBuckets {
  readonly unit: 'hour' | 'day';
  readonly labels: string[];
  readonly start: string;
  private readonly tz: string;

  constructor(tz: string, days: number, now = Date.now()) {
    this.tz = tz;
    const p = localParts(now, tz);
    const today = Date.UTC(p.year, p.month - 1, p.day);
    if (days === 1) {
      this.unit = 'hour';
      this.labels = Array.from({ length: p.hour + 1 }, (_, h) => `${pad(h)}:00`);
      this.start = new Date(zonedMidnight(p.year, p.month, p.day, tz)).toISOString();
    } else {
      this.unit = 'day';
      const n = days && days <= MAX_SERIES_DAYS ? days : MAX_SERIES_DAYS;
      this.labels = Array.from({ length: n }, (_, i) => isoDay(today - (n - 1 - i) * DAY_MS));
      const first = new Date(today - (n - 1) * DAY_MS);
      this.start = new Date(zonedMidnight(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate(), tz)).toISOString();
    }
  }

  /**
   * Each bucket's label and its [start, end) as UTC ISO strings: the ranges
   * keyOf() assigns, for counting in SQL instead of row by row.
   */
  bounds(): { label: string; start: string; end: string }[] {
    if (this.unit === 'hour') {
      const midnight = Date.parse(this.start);
      return this.labels.map((label, h) => ({
        label,
        start: new Date(midnight + h * 3_600_000).toISOString(),
        end: new Date(midnight + (h + 1) * 3_600_000).toISOString(),
      }));
    }
    const midnightOf = (label: string) => {
      const [y, m, d] = label.split('-').map(Number);
      return zonedMidnight(y, m, d, this.tz);
    };
    return this.labels.map((label) => {
      const [y, m, d] = label.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1, d) + DAY_MS);
      return {
        label,
        start: new Date(midnightOf(label)).toISOString(),
        end: new Date(zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), this.tz)).toISOString(),
      };
    });
  }

  keyOf(iso: string | null | undefined): string | null {
    if (!iso || iso < this.start) return null;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    if (this.unit === 'hour') return `${pad(localParts(ms, this.tz).hour)}:00`;
    return localDate(ms, this.tz);
  }

  /** Count (or sum `value`) of `rows` per bucket label. */
  group<T>(rows: T[], at: (r: T) => string | null | undefined, value: (r: T) => number = () => 1): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of rows) {
      const k = this.keyOf(at(r));
      if (k !== null) out.set(k, (out.get(k) ?? 0) + value(r));
    }
    return out;
  }
}

/**
 * The academic term an instant falls in: autumn
 * from August to January, spring from February to July.
 */
export function termIndex(ms: number, tz: string): number {
  const { year, month } = localParts(ms, tz);
  if (month >= 8) return year * 2 + 1;
  if (month === 1) return (year - 1) * 2 + 1;
  return year * 2;
}

/** The UTC instant term `index` starts (local midnight on 1 August or 1 February); it ends where `index + 1` starts. */
export function termStart(index: number, tz: string): number {
  return index % 2 ? zonedMidnight((index - 1) / 2, 8, 1, tz) : zonedMidnight(index / 2, 2, 1, tz);
}

export function termLabel(index: number) {
  return { year: Math.floor(index / 2), season: index % 2 ? 'autumn' : 'spring' };
}

/** Python round(): halves to even. */
export function roundHalfEven(x: number, digits = 0): number {
  const f = 10 ** digits;
  const v = x * f;
  const r = Math.round(v);
  const isHalf = Math.abs(v - Math.trunc(v)) === 0.5;
  const out = isHalf && r % 2 !== 0 ? r - 1 : r;
  return out / f;
}

export function ratio(num: number, den: number, digits = 4): number | null {
  return den ? roundHalfEven(num / den, digits) : null;
}

export function roundInt(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : roundHalfEven(value);
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Competition rank ("1, 2, 2, 4") among a fixed set; zero is unranked. */
export class CompetitionRank {
  private readonly values: number[];
  constructor(values: Iterable<number>) {
    this.values = [...values].filter((v) => v > 0).sort((a, b) => a - b);
  }
  rank(value: number | null | undefined): number | null {
    if (!value) return null;
    // bisect_right
    let lo = 0;
    let hi = this.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (value < this.values[mid]) hi = mid;
      else lo = mid + 1;
    }
    return this.values.length - lo + 1;
  }
}
