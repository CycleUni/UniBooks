/**
 * Which of a college's departments a search keyword names. Mirrors the
 * server's category match (server/src/services/listings/places.ts): case- and
 * space-insensitive, 學系 read as 系, and a trailing 系 dropped from the
 * keyword, so 資管, 資管系 and 資訊管理系 all name 資訊管理學系. The metadata
 * sends each department in the page language with its other-language
 * spellings among the aliases, so a keyword in any language matches.
 */
export interface Department {
  name: string;
  aliases: string[];
}

function matchKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/學系/g, '系');
}

/** Full names of the departments `query` names; a one-character keyword names none. */
export function matchedDepartments(departments: Department[] | undefined, query: string): string[] {
  let needle = matchKey(query);
  if (needle.length > 1 && needle.endsWith('系')) needle = needle.slice(0, -1);
  if (needle.length < 2 || !departments?.length) return [];
  // Like the server: EE or IM names only a whole short name, not the ee in Engineering.
  const shortLatin = /^[a-z0-9]{2}$/.test(needle);
  return departments
    .filter((d) =>
      [d.name, ...(d.aliases ?? [])].some((x) =>
        shortLatin ? matchKey(x) === needle : matchKey(x).includes(needle),
      ),
    )
    .map((d) => d.name);
}

/**
 * The departments `query` names, ready to show after the college in grey:
 * up to three, joined the way the page language lists (、 or a comma), with
 * … for the rest. Undefined when it names none.
 */
export function departmentHint(
  departments: Department[] | undefined,
  query: string,
  lang: string,
): string | undefined {
  const names = matchedDepartments(departments, query);
  if (!names.length) return undefined;
  const sep = lang.startsWith('zh') ? '、' : ', ';
  return names.length > 3 ? names.slice(0, 3).join(sep) + '…' : names.join(sep);
}
