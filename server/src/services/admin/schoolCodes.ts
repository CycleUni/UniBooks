import { and, eq } from 'drizzle-orm';
import { schools, type Database } from '../../db';

/**
 * School short codes ("NTU", "HKU").
 * A code is unique within a region only.
 */

export const CODE_MAX_LENGTH = 20;
const CODE_RE = /^[A-Z0-9-]+$/;
const NOT_CODE_CHARS = /[^A-Z0-9-]/g;
export const FALLBACK_CODE = 'SCHOOL';

/** Uppercase and strip every whitespace. Does not validate. */
export function normalizeCode(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, '').toUpperCase();
}

export function isValidCode(value: string): boolean {
  return !!value && value.length <= CODE_MAX_LENGTH && CODE_RE.test(value);
}

/** First label of the email domain, uppercased: ntu.edu.tw → NTU. */
export function deriveCode(emailDomain: string | null | undefined): string {
  const first = (emailDomain ?? '').trim().split('.')[0];
  const code = first.toUpperCase().replace(NOT_CODE_CHARS, '').slice(0, CODE_MAX_LENGTH);
  return code || FALLBACK_CODE;
}

/** `base`, or `base-2`, `base-3`, … — the first not in `taken`. */
export function dedupeCode(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, CODE_MAX_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Codes already used by schools of `regionCode`, optionally excluding one school. */
export async function regionCodes(db: Database, regionCode: string, excludeId?: number): Promise<Set<string>> {
  const rows = await db.select({ id: schools.id, code: schools.code }).from(schools).where(eq(schools.regionCode, regionCode));
  return new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.code));
}

/** The id `?school=` names in the region (code, then exact name); 0 for none. */
export async function schoolFilterId(db: Database, regionCode: string | null | undefined, value: string): Promise<number | null> {
  if (!value) return null;
  if (!regionCode) return 0;
  const code = normalizeCode(value);
  if (isValidCode(code)) {
    const [hit] = await db
      .select({ id: schools.id })
      .from(schools)
      .where(and(eq(schools.regionCode, regionCode), eq(schools.code, code)))
      .limit(1);
    if (hit) return hit.id;
  }
  const [byName] = await db
    .select({ id: schools.id })
    .from(schools)
    .where(and(eq(schools.regionCode, regionCode), eq(schools.name, value)))
    .limit(1);
  return byName ? byName.id : 0;
}

/**
 * `?school=` on the admin lists is an id, or
 * else a code / name resolved in the request's region.
 */
export async function adminSchoolFilterId(db: Database, regionCode: string | null, value: string): Promise<number | null> {
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v);
  return schoolFilterId(db, regionCode, v);
}
