/**
 * Organizations (a school's student union and the like) and who runs them.
 * Site staff create them and name their admins (routes/admin/organizations.ts);
 * the admins manage the roster (routes/orgs.ts) and, later, book drives.
 */
import type { Context } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppEnv, Env } from '../../env';
import { createDb, organizationAdmins, organizations, schools, type Organization } from '../../db';
import { apiError } from '../../lib/http';
import { localizedName } from '../accounts/regionData';

type SchoolRow = typeof schools.$inferSelect;

/** How an organization is shown everywhere: "致理科技大學 學生會". */
export function organizationDisplayName(school: SchoolRow | undefined, name: string, lang: string): string {
  const schoolName = school ? localizedName(school as unknown as Record<string, unknown>, lang) : '';
  return schoolName ? `${schoolName} ${name}` : name;
}

export function organizationJson(org: Organization, school: SchoolRow | undefined, lang: string) {
  return {
    id: org.id,
    region: org.regionCode,
    name: org.name,
    display_name: organizationDisplayName(school, org.name, lang),
    school: school ? { id: school.id, code: school.code, name: localizedName(school as unknown as Record<string, unknown>, lang) } : null,
    is_active: !!org.isActive,
    created_at: org.createdAt,
  };
}

export type OrganizationJson = ReturnType<typeof organizationJson>;

/** The schools of these organizations, by id, read once. */
export async function schoolsOf(env: Env, orgs: Organization[]): Promise<Map<number, SchoolRow>> {
  const ids = [...new Set(orgs.map((o) => o.schoolId))];
  if (!ids.length) return new Map();
  const rows = await createDb(env.DB).select().from(schools).where(inArray(schools.id, ids));
  return new Map(rows.map((s) => [s.id, s]));
}

/** The active organizations this user is an admin of (the /auth/me `organizations`). */
export async function organizationsAdministeredBy(env: Env, userId: string, lang: string): Promise<OrganizationJson[]> {
  const rows = await createDb(env.DB)
    .select({ org: organizations })
    .from(organizationAdmins)
    .innerJoin(organizations, eq(organizations.id, organizationAdmins.organizationId))
    .where(and(eq(organizationAdmins.userId, userId), eq(organizations.isActive, 1)));
  const orgs = rows.map((r) => r.org);
  const schoolMap = await schoolsOf(env, orgs);
  return orgs.map((o) => organizationJson(o, schoolMap.get(o.schoolId), lang)).sort((a, b) => a.display_name.localeCompare(b.display_name));
}

/**
 * The active organization `id` when the signed-in user is one of its admins.
 * Anything else answers 404, so an outsider cannot tell which ids exist.
 */
export async function requireOrgAdmin(c: Context<AppEnv>, id: string): Promise<Organization> {
  const user = c.get('user');
  if (!user) apiError(401, 'auth.errNotLoggedIn');
  const [row] = await createDb(c.env.DB)
    .select({ org: organizations })
    .from(organizationAdmins)
    .innerJoin(organizations, eq(organizations.id, organizationAdmins.organizationId))
    .where(and(eq(organizationAdmins.organizationId, id), eq(organizationAdmins.userId, user.id), eq(organizations.isActive, 1)))
    .limit(1);
  if (!row) apiError(404, 'common.errNotFound');
  return row.org;
}
