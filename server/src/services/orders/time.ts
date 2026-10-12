/**
 * Meetup times. The app's meetup form sends a naive local time
 * ("2030-01-02T18:30", or just "2030-01-02"). It is read in the order's region's
 * timezone, which is the same zone for TW and the same offset for HK, and
 * stored as a UTC ISO string so string comparison in SQL orders correctly.
 */

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/;

function partsIn(ts: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ts))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Milliseconds `timeZone` is ahead of UTC at instant `ts`. */
function offsetAt(ts: number, timeZone: string): number {
  const p = partsIn(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

function safeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'Asia/Taipei';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'Asia/Taipei';
  }
}

/**
 * Parse a meetup time from the API. Returns a UTC ISO string, null for an
 * explicit clear (null / ''), or undefined when the value is not a time.
 */
export function parseMeetupTime(value: unknown, timeZone: string | null | undefined): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  const naive = NAIVE.exec(v);
  if (naive) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0'] = naive;
    const ms = Number(frac.padEnd(3, '0').slice(0, 3));
    const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
    const check = new Date(guess);
    if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) return undefined;
    const zone = safeZone(timeZone);
    let ts = guess - offsetAt(guess, zone);
    ts = guess - offsetAt(ts, zone); // across a DST change
    return new Date(ts).toISOString();
  }
  // An aware ISO-8601 time (Z or ±HH:MM).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const ts = Date.parse(v.replace(' ', 'T'));
    return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
  }
  return undefined;
}

/** "YYYY-MM-DD HH:MM" in `timeZone`. */
export function formatLocal(iso: string, timeZone: string | null | undefined): string {
  const ts = Date.parse(iso);
  const p = partsIn(ts, safeZone(timeZone));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}
