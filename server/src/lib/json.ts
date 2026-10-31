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
/** A department's name and short names in one language. */
export interface DepartmentNames {
  name: string;
  aliases: string[];
}

/**
 * A college's department: `name`/`aliases` in the region's own language, and
 * the other languages under `translations` ({"en": {"name": "Information
 * Management", "aliases": ["IM"]}}), left out when there are none.
 */
export interface Department extends DepartmentNames {
  translations?: Record<string, DepartmentNames>;
}

function departmentNames(value: unknown): DepartmentNames | null {
  if (!value || typeof value !== 'object') return null;
  const name = (value as Record<string, unknown>).name;
  if (typeof name !== 'string' || !name.trim()) return null;
  return { name: name.trim(), aliases: stringList((value as Record<string, unknown>).aliases) };
}

/** A category's departments column; malformed entries and translations are dropped. */
export function parseDepartments(value: unknown): Department[] {
  const raw = parseJson<unknown>(value, []);
  if (!Array.isArray(raw)) return [];
  const out: Department[] = [];
  for (const d of raw) {
    const names = departmentNames(d);
    if (!names) continue;
    const translations: Record<string, DepartmentNames> = {};
    const t = (d as Record<string, unknown>).translations;
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      for (const [lang, v] of Object.entries(t)) {
        const tn = departmentNames(v);
        if (tn) translations[lang] = tn;
      }
    }
    out.push(Object.keys(translations).length ? { ...names, translations } : names);
  }
  return out;
}

/** Every name and short name a department goes by, in any language. */
export function departmentSpellings(d: Department): string[] {
  return [d.name, ...d.aliases, ...Object.values(d.translations ?? {}).flatMap((t) => [t.name, ...t.aliases])];
}

/**
 * A department as `lang` reads it: that language's name (exact tag, then the
 * same base language, then the region's own), with every other spelling as
 * aliases so a keyword in any language still names it.
 */
export function localizeDepartment(d: Department, lang: string): DepartmentNames {
  const t = d.translations ?? {};
  const base = lang.split('-')[0];
  const picked = t[lang] ?? Object.entries(t).find(([k]) => k.split('-')[0] === base)?.[1];
  const name = picked?.name ?? d.name;
  return { name, aliases: [...new Set(departmentSpellings(d))].filter((x) => x !== name) };
}
