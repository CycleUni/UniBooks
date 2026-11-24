/**
 * Course names are typed freely by sellers; lib/course.ts' key says which
 * spellings are one course. This is the one place that merges them, for the
 * course browser (/courses) and the search page's course filter alike.
 */
import type { Env } from '../../env';
import { courseKey } from '../../lib/course';

export interface MergedCourse<T extends { name: string; n: number }> {
  key: string;
  /** The spelling to show: the one most listings use (shorter, then alphabetical, on a tie). */
  name: string;
  /** `n` summed over the spellings. */
  n: number;
  /** The spellings merged, as given. */
  rows: T[];
}

/** One entry per course key, in the order each key first appears. Rows with no key (punctuation only) are dropped. */
export function mergeSpellings<T extends { name: string; n: number }>(rows: T[]): MergedCourse<T>[] {
  const byKey = new Map<string, MergedCourse<T>>();
  for (const row of rows) {
    const key = courseKey(row.name);
    if (!key) continue;
    const merged = byKey.get(key);
    if (merged) {
      merged.rows.push(row);
      merged.n += row.n;
    } else {
      byKey.set(key, { key, name: row.name, n: row.n, rows: [row] });
    }
  }
  for (const m of byKey.values()) {
    const best = [...m.rows].sort((a, b) => b.n - a.n || a.name.length - b.name.length || a.name.localeCompare(b.name))[0];
    m.name = best.name;
  }
  return [...byKey.values()];
}

/**
 * Every spelling of `name`'s course used by a listing in the region (or one school).
 * A name no listing uses comes back as itself, so a filter on it matches what it always did: nothing.
 */
export async function courseSpellings(env: Env, regionCode: string, schoolId: number | null, name: string): Promise<string[]> {
  const key = courseKey(name);
  if (!key) return [name];
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT course_name AS name FROM listings
      WHERE region_code = ? AND course_name <> ''${schoolId === null ? '' : ' AND school_id = ?'}`,
  )
    .bind(...(schoolId === null ? [regionCode] : [regionCode, schoolId]))
    .all<{ name: string }>();
  const names = results.map((r) => r.name).filter((n) => courseKey(n) === key);
  return names.length ? names : [name];
}
