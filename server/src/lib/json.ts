/** A JSON column read defensively: an already-parsed value passes through, empty or malformed text gives `fallback`. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** A JSON-array column; anything else (null, malformed, not an array) is []. */
export function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** A JSON-object column; anything else (null, malformed, an array) is {}. */
export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A JSON list column, or a single bare value, or a comma-separated string, as a list of strings. */
export function stringList(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) return stringList(parseJson<unknown>(trimmed, []));
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** A photos column: a JSON array of names (or the array itself) reduced to its strings. */
export function parsePhotos(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** One department of a college category: its full name and short names (資訊管理學系 → 資管). */
export interface Department {
  name: string;
  aliases: string[];
}

/** A category's departments column; malformed entries are dropped. */
export function parseDepartments(value: unknown): Department[] {
  const raw = parseJson<unknown>(value, []);
  if (!Array.isArray(raw)) return [];
  const out: Department[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const name = (d as Record<string, unknown>).name;
    if (typeof name !== 'string' || !name.trim()) continue;
    out.push({ name: name.trim(), aliases: stringList((d as Record<string, unknown>).aliases) });
  }
  return out;
}
