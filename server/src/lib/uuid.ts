/** Canonical hyphenated UUID, e.g. a stored row id. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID whose hyphens are optional, for inputs that may carry the compact form. */
export const UUID_LOOSE_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** The strict UUID as a regex fragment, for Hono route patterns such as `/:id{...}`. */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** UUIDs are stored hyphenated and lower-case; accept the unhyphenated form too. */
export function normUuid(v: string): string {
  const h = v.toLowerCase().replace(/-/g, '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A fresh random id as 32 hex characters (a UUID without hyphens). */
export function newHexId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
