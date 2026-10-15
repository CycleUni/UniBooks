import type { Env, AuthUser } from '../../env';

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
    const { results } = await env.DB.prepare('SELECT region_code FROM staff_managed_regions WHERE user_id = ?')
      .bind(user.id)
      .all<{ region_code: string }>();
    return results.map((r) => r.region_code);
  } catch {
    return [];
  }
}
