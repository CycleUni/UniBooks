/**
 * Who may do what in a book drive. Two roles: the organization's admins
 * ('admin': everything, including its settings and its staff) and the staff
 * they named for the drive ('staff': intake and, later, pickup). Site staff
 * have no role here unless they hold one of these: drives carry students'
 * details. Anyone else gets a 404 for every drive, so ids reveal nothing.
 */
import type { Context } from 'hono';
import { and, eq, ne } from 'drizzle-orm';
import type { AppEnv, Env } from '../../env';
import { bookDrives, bookDriveStaff, createDb, organizationAdmins, organizations, type BookDrive, type Organization } from '../../db';
import { apiError } from '../../lib/http';
import { organizationDisplayName, schoolsOf } from '../orgs/organizations';

export type DriveRole = 'admin' | 'staff';

export interface DriveAccess {
  drive: BookDrive;
  org: Organization;
  role: DriveRole;
}

/** The drive `id` and this user's role in it; 404 without one, 403 when `need` is admin and they are staff. */
export async function requireDrive(c: Context<AppEnv>, id: string, need: DriveRole): Promise<DriveAccess> {
  const user = c.get('user');
  if (!user) apiError(401, 'auth.errNotLoggedIn');
  const db = createDb(c.env.DB);
  const [row] = await db
    .select({
      drive: bookDrives,
      org: organizations,
      isAdmin: organizationAdmins.userId,
      isStaff: bookDriveStaff.userId,
    })
    .from(bookDrives)
    .innerJoin(organizations, and(eq(organizations.id, bookDrives.organizationId), eq(organizations.isActive, 1)))
    .leftJoin(organizationAdmins, and(eq(organizationAdmins.organizationId, organizations.id), eq(organizationAdmins.userId, user.id)))
    .leftJoin(bookDriveStaff, and(eq(bookDriveStaff.driveId, bookDrives.id), eq(bookDriveStaff.userId, user.id)))
    .where(eq(bookDrives.id, id))
    .limit(1);
  const role: DriveRole | null = row?.isAdmin ? 'admin' : row?.isStaff ? 'staff' : null;
  if (!row || !role) apiError(404, 'common.errNotFound');
  if (need === 'admin' && role !== 'admin') apiError(403, 'drive.errAdminOnly');
  return { drive: row.drive, org: row.org, role };
}

/** Writes that collect books only while the drive is collecting them. */
export function assertCollecting(drive: BookDrive): void {
  if (drive.status !== 'intake') apiError(400, 'drive.errNotCollecting');
}

/** The open drives this account works as staff (the /auth/me `staffed_drives`), newest first. */
export async function drivesStaffedBy(env: Env, userId: string, lang: string) {
  const rows = await createDb(env.DB)
    .select({ drive: bookDrives, org: organizations })
    .from(bookDriveStaff)
    .innerJoin(bookDrives, eq(bookDrives.id, bookDriveStaff.driveId))
    .innerJoin(organizations, and(eq(organizations.id, bookDrives.organizationId), eq(organizations.isActive, 1)))
    .where(and(eq(bookDriveStaff.userId, userId), ne(bookDrives.status, 'closed')));
  const schools = await schoolsOf(
    env,
    rows.map((r) => r.org),
  );
  return rows
    .sort((a, b) => b.drive.createdAt.localeCompare(a.drive.createdAt))
    .map((r) => ({
      id: r.drive.id,
      title: r.drive.title,
      status: r.drive.status,
      region: r.drive.regionCode,
      organization: { id: r.org.id, display_name: organizationDisplayName(schools.get(r.org.schoolId), r.org.name, lang) },
    }));
}
