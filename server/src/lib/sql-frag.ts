/** A SQL fragment and its bind values, in order. */
export interface Frag {
  sql: string;
  args: unknown[];
}

export const frag = (sql: string, ...args: unknown[]): Frag => ({ sql, args });
export const EMPTY: Frag = frag('');

export function join(parts: Frag[], sep = ' AND '): Frag {
  const live = parts.filter((p) => p.sql);
  return { sql: live.map((p) => p.sql).join(sep), args: live.flatMap((p) => p.args) };
}

/** " AND <a> AND <b>" for appending to an existing WHERE. */
export function andAll(parts: Frag[]): Frag {
  const j = join(parts);
  return j.sql ? { sql: ` AND ${j.sql}`, args: j.args } : EMPTY;
}
