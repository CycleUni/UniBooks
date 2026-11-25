/**
 * How long a "tell me when it is listed" request (a book request or a course request) lasts.
 * The default is half a year, a semester or two; "unlimited" is the account holder's choice.
 * An expired request stops counting at once (see notExpired) and the nightly cleanup deletes it.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { nowIso } from './time';

export const REQUEST_DURATIONS = ['half_year', 'unlimited'] as const;
export type RequestDuration = (typeof REQUEST_DURATIONS)[number];

/** Months a "half_year" request lasts. */
const HALF_YEAR_MONTHS = 6;

/** The duration a request body names; anything unknown is the default. */
export function parseDuration(value: unknown): RequestDuration {
  return REQUEST_DURATIONS.find((d) => d === value) ?? 'half_year';
}

/** When a request made at `from` with this duration expires; null = never. */
export function expiryFor(duration: RequestDuration, from = new Date()): string | null {
  if (duration === 'unlimited') return null;
  const at = new Date(from);
  at.setUTCMonth(at.getUTCMonth() + HALF_YEAR_MONTHS);
  return at.toISOString();
}

/** SQL for "this request is still in force". */
export function notExpired(column: SQLiteColumn, now = nowIso()): SQL {
  return sql`(${column} IS NULL OR ${column} > ${now})`;
}
