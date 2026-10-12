import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * `column IN (values)` bound as ONE JSON parameter (`json_each`), not one
 * parameter per value: D1 rejects statements with more than 100 bound
 * parameters, so `inArray()` over a user-sized list is a latent 500.
 * An empty list matches nothing.
 */
export function inList(column: AnyColumn | SQL, values: readonly (string | number)[]): SQL {
  if (values.length === 0) return sql`0`;
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}
