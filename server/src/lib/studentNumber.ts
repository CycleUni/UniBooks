/**
 * A student number as stored everywhere (student ID verifications, rosters):
 * trimmed and upper-cased, 4 to 20 letters, digits or hyphens. Null when the
 * value is not one.
 */
export function normalizeStudentNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const n = value.trim().toUpperCase();
  return /^[A-Z0-9-]{4,20}$/.test(n) ? n : null;
}
