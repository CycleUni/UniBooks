import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, AuthUser } from '../../env';
import { createDb, staffManagedRegions, type Database } from '../../db';
import { apiError } from '../../lib/http';
import { UUID_RE } from '../../lib/uuid';

/**
 * Region scoping: the `managed_regions` filters every admin view applies.
 *
 * A superuser manages every region (null). Any other staff account manages
 * exactly the regions in staff_managed_regions — possibly none, in which
 * case every region-scoped list comes back empty and every object 404s.
 */
export async function managedRegions(db: Database, user: AuthUser): Promise<string[] | null> {
  if (user.isSuperuser) return null;
  const rows = await db
    .select({ code: staffManagedRegions.regionCode })
    .from(staffManagedRegions)
    .where(eq(staffManagedRegions.userId, user.id));
  return rows.map((r) => r.code);
}

const scopeCache = new WeakMap<Request, string[] | null>();

/** The current user's managed regions, cached per request. */
export async function scopeOf(c: Context<AppEnv>): Promise<string[] | null> {
  if (scopeCache.has(c.req.raw)) return scopeCache.get(c.req.raw)!;
  const user = c.get('user');
  if (!user) apiError(401, 'auth.errNotLoggedIn');
  const scope = await managedRegions(createDb(c.env.DB), user);
  scopeCache.set(c.req.raw, scope);
  return scope;
}

export function inScope(scope: string[] | null, regionCode: string | null | undefined): boolean {
  if (scope === null) return true;
  return !!regionCode && scope.includes(regionCode);
}

/** 403 admin.errRegionForbidden unless the user manages `regionCode`. */
export function assertInScope(scope: string[] | null, regionCode: string | null | undefined): void {
  if (!inScope(scope, regionCode)) apiError(403, 'admin.errRegionForbidden');
}

/** `?region=`, uppercased as the admin views compare it ('' when absent). */
export function regionParam(c: Context<AppEnv>): string {
  return (c.req.query('region') ?? '').trim().toUpperCase();
}

/** 404 for a missing object: {"detail": "Not found."}. */
export function notFound(): never {
  throw new HTTPException(404, { res: Response.json({ detail: 'Not found.' }, { status: 404 }), message: 'not found' });
}

/** Parse a positive integer path id, or 404. */
export function intId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) notFound();
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) notFound();
  return n;
}

/** Parse a UUID path id; anything else 404s. */
export function uuidId(raw: string | undefined): string {
  if (!raw || !UUID_RE.test(raw)) notFound();
  return raw.toLowerCase();
}

/** LIKE pattern for a case-insensitive "contains" with %, _ and \ escaped (use with ESCAPE '\'). */
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
