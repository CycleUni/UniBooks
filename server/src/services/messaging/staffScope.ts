import { eq } from 'drizzle-orm';
import type { Env, AuthUser } from '../../env';
import { createDb, staffManagedRegions } from '../../db';

/**
 * Admins see every region; other staff see
 * only the regions they manage (their managed regions).
 *
 * Returns null for "all regions", else the list of region codes.
 *
 * Reads `staff_managed_regions(user_id, region_code)`. Any failure scopes
 * staff to nothing — fail closed, never open.
 */
export async function managedRegionCodes(env: Env, user: AuthUser): Promise<string[] | null> {
  if (user.isAdmin) return null;
  try {
    const results = await createDb(env.DB)
      .select({ regionCode: staffManagedRegions.regionCode })
      .from(staffManagedRegions)
      .where(eq(staffManagedRegions.userId, user.id));
    return results.map((r) => r.regionCode);
  } catch {
    return [];
  }
}
