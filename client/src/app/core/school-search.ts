/**
 * What a school can be found by when typed into a school picker: its name in
 * every language, its short code and its email domain. Pickers used to match
 * only the name shown in the page's language, so 臺灣大學 found nothing on
 * the English site and "NTU" found nothing on the Chinese one.
 */
export interface SearchableSchool {
  name: string;
  display_name?: string;
  code?: string;
  email_domain?: string;
  /** Every name the school goes by, as /core/metadata/ lists it. */
  names?: string[];
  /** Localized fields per language, as the admin API returns them. */
  translations?: unknown;
}

export function schoolKeywords(s: SearchableSchool): string[] {
  const words = [s.display_name, s.name, ...(s.names ?? []), s.code, s.email_domain];
  if (s.translations && typeof s.translations === 'object') {
    for (const fields of Object.values(s.translations as Record<string, unknown>)) {
      const name = (fields as { name?: unknown } | null)?.name;
      if (typeof name === 'string') words.push(name);
    }
  }
  return [...new Set(words.filter((w): w is string => !!w))];
}

/** Whether `query` (already trimmed and lowercased) is in any of `keywords`. */
export function keywordsMatch(keywords: readonly string[] | undefined, query: string): boolean {
  return !!keywords?.some(k => k.toLowerCase().includes(query));
}
