/**
 * Registering for a drive's books (登記; docs/plans/2026-11-27-drive-claims/plan.md).
 * The only place the rules live: when a drive takes registrations, who may
 * register, the per-person limit, where the student number comes from and
 * what the public sees of a drive.
 *
 * A drive takes registrations while it is `claiming` and now is within
 * [claim_opens_at, claim_closes_at). A registration is for a title, not a
 * copy, and only for a title the drive still has a copy of on the shelf.
 * Registering takes nothing: more people may register than there are copies;
 * allocation (phase 4) decides who gets one.
 */
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { Env } from '../../env';
import {
  bookDrives,
  books,
  createDb,
  driveClaims,
  driveCopies,
  organizationMembers,
  organizations,
  studentIdVerifications,
  type BookDrive,
  type DriveClaim,
  type Organization,
} from '../../db';
import { inList } from '../../lib/sql';
import { apiError } from '../../lib/http';
import { coverUrlFor } from '../catalog/covers';
import { organizationDisplayName, schoolsOf } from '../orgs/organizations';
import { today } from '../orgs/roster';
import { runsDrives } from './access';

/** The longest a drive may take registrations for. */
export const MAX_CLAIM_WINDOW_DAYS = 90;
/** Registrations, edits and cancellations one account may make in an hour. */
export const CLAIM_RATE = '60/hour';

/** Whether `drive` takes registrations at `now` (ISO). The close time itself is already closed. */
export function claimsOpen(drive: Pick<BookDrive, 'status' | 'claimOpensAt' | 'claimClosesAt'>, now: string): boolean {
  return (
    drive.status === 'claiming' && !!drive.claimOpensAt && !!drive.claimClosesAt && drive.claimOpensAt <= now && now < drive.claimClosesAt
  );
}

/** A drive the public may see (registering, or registration over and awaiting allocation), with its organization; null otherwise. */
export async function publicDrive(env: Env, id: string): Promise<{ drive: BookDrive; org: Organization } | null> {
  const [row] = await createDb(env.DB)
    .select({ drive: bookDrives, org: organizations })
    .from(bookDrives)
    .innerJoin(organizations, runsDrives)
    .where(and(eq(bookDrives.id, id), eq(bookDrives.status, 'claiming')))
    .limit(1);
  return row ?? null;
}

/** The student number staff approved for this account at `schoolId`, newest first; '' when none. */
export async function approvedStudentNumber(env: Env, userId: string, regionCode: string, schoolId: number): Promise<string> {
  const [row] = await createDb(env.DB)
    .select({ number: studentIdVerifications.studentNumber })
    .from(studentIdVerifications)
    .where(
      and(
        eq(studentIdVerifications.userId, userId),
        eq(studentIdVerifications.regionCode, regionCode),
        eq(studentIdVerifications.schoolId, schoolId),
        eq(studentIdVerifications.status, 'approved'),
      ),
    )
    .orderBy(desc(studentIdVerifications.reviewedAt))
    .limit(1);
  return row?.number ?? '';
}

/**
 * What the registration form starts with: the approved student number (read
 * only) and, when the organization's roster has that number, its department
 * and year. Only the account's own details, never anyone else's.
 */
export async function claimDefaults(env: Env, org: Organization, userId: string) {
  const studentNumber = await approvedStudentNumber(env, userId, org.regionCode, org.schoolId);
  let department = '';
  let grade: number | null = null;
  let fromRoster = false;
  if (studentNumber) {
    const [m] = await createDb(env.DB)
      .select({ department: organizationMembers.department, grade: organizationMembers.grade })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, org.id),
          eq(organizationMembers.studentNumber, studentNumber),
          sql`${organizationMembers.validUntil} >= ${today()}`,
        ),
      )
      .limit(1);
    if (m) {
      department = m.department;
      grade = m.grade;
      fromRoster = true;
    }
  }
  return { student_number: studentNumber, department, grade, from_roster: fromRoster };
}

export interface ClaimInput {
  department: string;
  grade: number | null;
}

/**
 * Register `userId` for `bookId`, or bring back their cancelled registration.
 * One statement checks and writes, so the limit holds when two requests race:
 * the drive is open, a copy of the title is on the shelf, the account is under
 * its limit, and it has no live registration for the title. When nothing was
 * written, the reason becomes the error.
 */
export async function createClaim(
  env: Env,
  drive: BookDrive,
  org: Organization,
  userId: string,
  bookId: string,
  input: ClaimInput,
  now: string,
): Promise<DriveClaim> {
  const studentNumber = await approvedStudentNumber(env, userId, org.regionCode, org.schoolId);
  const res = await env.DB.prepare(
    `INSERT INTO drive_claims (id, drive_id, book_id, user_id, student_number, department, grade, status, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'registered', ?8, ?8
      WHERE EXISTS (SELECT 1 FROM book_drives d WHERE d.id = ?2 AND d.status = 'claiming'
                      AND d.claim_opens_at <= ?8 AND d.claim_closes_at > ?8)
        AND EXISTS (SELECT 1 FROM drive_copies k WHERE k.drive_id = ?2 AND k.book_id = ?3 AND k.status = 'in_stock')
        AND (SELECT count(*) FROM drive_claims x WHERE x.drive_id = ?2 AND x.user_id = ?4 AND x.status = 'registered') < ?9
     ON CONFLICT (drive_id, user_id, book_id) DO UPDATE
        SET status = 'registered', student_number = excluded.student_number, department = excluded.department,
            grade = excluded.grade, updated_at = excluded.updated_at
      WHERE drive_claims.status = 'cancelled'`,
  )
    .bind(crypto.randomUUID(), drive.id, bookId, userId, studentNumber, input.department, input.grade, now, drive.maxClaimsPerUser)
    .run();

  const db = createDb(env.DB);
  const [claim] = await db
    .select()
    .from(driveClaims)
    .where(and(eq(driveClaims.driveId, drive.id), eq(driveClaims.userId, userId), eq(driveClaims.bookId, bookId)))
    .limit(1);
  if (res.meta.changes && claim) return claim;

  // Nothing written: say why, most specific first.
  if (!claimsOpen(drive, now)) apiError(400, 'drive.errClaimsClosed');
  if (claim?.status === 'registered') apiError(409, 'drive.errAlreadyClaimed');
  const [{ onShelf }] = await db
    .select({ onShelf: count() })
    .from(driveCopies)
    .where(and(eq(driveCopies.driveId, drive.id), eq(driveCopies.bookId, bookId), eq(driveCopies.status, 'in_stock')));
  if (!onShelf) apiError(400, 'drive.errNoCopies');
  apiError(400, 'drive.errClaimLimit', { max: drive.maxClaimsPerUser });
}

/** The account's registration `claimId` in `drive`, or 404. */
export async function ownClaim(env: Env, drive: BookDrive, userId: string, claimId: string): Promise<DriveClaim> {
  const [claim] = await createDb(env.DB)
    .select()
    .from(driveClaims)
    .where(and(eq(driveClaims.id, claimId), eq(driveClaims.driveId, drive.id), eq(driveClaims.userId, userId)))
    .limit(1);
  if (!claim) apiError(404, 'common.errNotFound');
  return claim;
}

/** Change or cancel a live registration while the drive takes them. */
export async function changeClaim(
  env: Env,
  drive: BookDrive,
  claim: DriveClaim,
  set: Partial<Pick<DriveClaim, 'department' | 'grade' | 'status'>>,
  now: string,
): Promise<DriveClaim> {
  if (!claimsOpen(drive, now)) apiError(400, 'drive.errClaimsClosed');
  if (claim.status !== 'registered') apiError(400, 'drive.errClaimNotLive');
  const res = await createDb(env.DB)
    .update(driveClaims)
    .set({ ...set, updatedAt: now })
    .where(and(eq(driveClaims.id, claim.id), eq(driveClaims.status, 'registered')))
    .run();
  if (!res.meta.changes) apiError(409, 'drive.errClaimNotLive');
  return { ...claim, ...set, updatedAt: now };
}

export function claimJson(c: DriveClaim) {
  return {
    id: c.id,
    book_id: c.bookId,
    status: c.status,
    student_number: c.studentNumber,
    department: c.department,
    grade: c.grade,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/** Copies on the shelf and live registrations per title, for the given drives (and titles, when named). */
async function titleCounts(env: Env, driveIds: string[], bookIds?: string[]) {
  const db = createDb(env.DB);
  const [shelf, claims] = await Promise.all([
    db
      .select({ driveId: driveCopies.driveId, bookId: driveCopies.bookId, n: count() })
      .from(driveCopies)
      .where(
        and(
          inList(driveCopies.driveId, driveIds),
          eq(driveCopies.status, 'in_stock'),
          bookIds ? inList(driveCopies.bookId, bookIds) : undefined,
        ),
      )
      .groupBy(driveCopies.driveId, driveCopies.bookId),
    db
      .select({ driveId: driveClaims.driveId, bookId: driveClaims.bookId, n: count() })
      .from(driveClaims)
      .where(
        and(
          inList(driveClaims.driveId, driveIds),
          eq(driveClaims.status, 'registered'),
          bookIds ? inList(driveClaims.bookId, bookIds) : undefined,
        ),
      )
      .groupBy(driveClaims.driveId, driveClaims.bookId),
  ]);
  const key = (d: string, b: string) => `${d}|${b}`;
  return {
    onShelf: new Map(shelf.map((r) => [key(r.driveId, r.bookId), r.n])),
    claimants: new Map(claims.map((r) => [key(r.driveId, r.bookId), r.n])),
    key,
  };
}

/** The viewer's registrations in these drives, by drive and title. */
async function viewerClaims(env: Env, userId: string | undefined, driveIds: string[]) {
  if (!userId || !driveIds.length) return new Map<string, DriveClaim>();
  const rows = await createDb(env.DB)
    .select()
    .from(driveClaims)
    .where(and(eq(driveClaims.userId, userId), inList(driveClaims.driveId, driveIds)));
  return new Map(rows.map((r) => [`${r.driveId}|${r.bookId}`, r]));
}

function driveHead(drive: BookDrive, displayName: string, now: string) {
  return {
    id: drive.id,
    region: drive.regionCode,
    title: drive.title,
    description: drive.description,
    status: drive.status,
    organization: { id: drive.organizationId, display_name: displayName },
    claim_opens_at: drive.claimOpensAt,
    claim_closes_at: drive.claimClosesAt,
    max_claims_per_user: drive.maxClaimsPerUser,
    open: claimsOpen(drive, now),
  };
}

/**
 * What a book page pins for `bookId`: one entry per drive registering for it
 * that has a copy on the shelf or that the viewer registered with. Counts
 * only; never who gave or who registered.
 */
export async function drivesForBook(env: Env, bookId: string, regionCode: string, lang: string, userId: string | undefined, now: string) {
  const db = createDb(env.DB);
  const rows = await db
    .selectDistinct({ drive: bookDrives, org: organizations })
    .from(bookDrives)
    .innerJoin(organizations, runsDrives)
    .innerJoin(driveCopies, and(eq(driveCopies.driveId, bookDrives.id), eq(driveCopies.bookId, bookId)))
    .where(and(eq(bookDrives.regionCode, regionCode), eq(bookDrives.status, 'claiming')))
    .orderBy(asc(bookDrives.claimClosesAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.drive.id);
  const [counts, mine, schools] = await Promise.all([
    titleCounts(env, ids, [bookId]),
    viewerClaims(env, userId, ids),
    schoolsOf(
      env,
      rows.map((r) => r.org),
    ),
  ]);
  return rows
    .map(({ drive, org }) => {
      const k = counts.key(drive.id, bookId);
      const claim = mine.get(k);
      return {
        ...driveHead(drive, organizationDisplayName(schools.get(org.schoolId), org.name, lang), now),
        remaining: counts.onShelf.get(k) ?? 0,
        claimants: counts.claimants.get(k) ?? 0,
        my_claim: claim && claim.status !== 'cancelled' ? claimJson(claim) : null,
      };
    })
    .filter((d) => d.remaining > 0 || d.my_claim);
}

type Counts = Awaited<ReturnType<typeof titleCounts>>;

/** A drive's titles with a copy on the shelf (or that the viewer registered for), with their counts. */
async function driveTitles(env: Env, origin: string, driveId: string, counts: Counts, mine: Map<string, DriveClaim>) {
  const bookIds = new Set<string>();
  for (const k of counts.onShelf.keys()) if (k.startsWith(`${driveId}|`)) bookIds.add(k.split('|')[1]);
  for (const c of mine.values()) if (c.driveId === driveId && c.status !== 'cancelled') bookIds.add(c.bookId);
  const bookRows = bookIds.size
    ? await createDb(env.DB)
        .select()
        .from(books)
        .where(inList(books.id, [...bookIds]))
    : [];
  return bookRows.map((b) => {
    const k = counts.key(driveId, b.id);
    const claim = mine.get(k);
    return {
      book: { id: b.id, title: b.title, authors: b.authors, isbn13: b.isbn13, cover_url: coverUrlFor(env, origin, b) },
      remaining: counts.onShelf.get(k) ?? 0,
      claimants: counts.claimants.get(k) ?? 0,
      my_claim: claim && claim.status !== 'cancelled' ? claimJson(claim) : null,
    };
  });
}

/** A drive's public page: its titles with copies on the shelf (or that the viewer registered for). */
export async function drivePage(
  env: Env,
  origin: string,
  drive: BookDrive,
  org: Organization,
  lang: string,
  userId: string | undefined,
  now: string,
) {
  const [counts, mine, schools] = await Promise.all([
    titleCounts(env, [drive.id]),
    viewerClaims(env, userId, [drive.id]),
    schoolsOf(env, [org]),
  ]);
  const titles = (await driveTitles(env, origin, drive.id, counts, mine)).sort((a, b) => a.book.title.localeCompare(b.book.title));
  const myCount = [...mine.values()].filter((c) => c.status === 'registered').length;
  return {
    ...driveHead(drive, organizationDisplayName(schools.get(org.schoolId), org.name, lang), now),
    my_claims: myCount,
    titles,
  };
}

/** The most titles a list of drives previews for each (a school's home page). */
export const MAX_PREVIEW_TITLES = 12;

/**
 * The drives taking (or that took) registrations in `regionCode`, for the
 * public lists; with `schoolId`, only its organizations' (a school's home
 * page). With `titles`, each open drive also previews that many of its
 * titles, those with the most copies left first.
 */
export async function openDrives(
  env: Env,
  regionCode: string,
  lang: string,
  now: string,
  opts: { schoolId?: number | null; titles?: number; userId?: string; origin?: string } = {},
) {
  const rows = await createDb(env.DB)
    .select({ drive: bookDrives, org: organizations })
    .from(bookDrives)
    .innerJoin(organizations, runsDrives)
    .where(
      and(
        eq(bookDrives.regionCode, regionCode),
        eq(bookDrives.status, 'claiming'),
        opts.schoolId != null ? eq(organizations.schoolId, opts.schoolId) : undefined,
      ),
    )
    .orderBy(asc(bookDrives.claimClosesAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.drive.id);
  const preview = Math.min(Math.max(0, Math.floor(opts.titles ?? 0)), MAX_PREVIEW_TITLES);
  const [counts, schools, mine] = await Promise.all([
    titleCounts(env, ids),
    schoolsOf(
      env,
      rows.map((r) => r.org),
    ),
    preview ? viewerClaims(env, opts.userId, ids) : Promise.resolve(new Map<string, DriveClaim>()),
  ]);
  return Promise.all(
    rows.map(async ({ drive, org }) => {
      let copies = 0;
      let titles = 0;
      for (const [k, n] of counts.onShelf) {
        if (k.startsWith(`${drive.id}|`)) {
          copies += n;
          titles += 1;
        }
      }
      const head = driveHead(drive, organizationDisplayName(schools.get(org.schoolId), org.name, lang), now);
      if (!preview || !head.open) return { ...head, titles, copies };
      const list = (await driveTitles(env, opts.origin ?? '', drive.id, counts, mine))
        .filter((t) => t.remaining > 0)
        .sort((a, b) => b.remaining - a.remaining || a.book.title.localeCompare(b.book.title))
        .slice(0, preview);
      return { ...head, titles, copies, preview: list };
    }),
  );
}

/** The account's registrations, newest first, with their drives and books; cancelled ones left out. */
export async function claimsOf(env: Env, origin: string, userId: string, lang: string, now: string) {
  const rows = await createDb(env.DB)
    .select({ claim: driveClaims, drive: bookDrives, org: organizations, book: books })
    .from(driveClaims)
    .innerJoin(bookDrives, eq(bookDrives.id, driveClaims.driveId))
    .innerJoin(organizations, eq(organizations.id, bookDrives.organizationId))
    .innerJoin(books, eq(books.id, driveClaims.bookId))
    .where(and(eq(driveClaims.userId, userId), sql`${driveClaims.status} != 'cancelled'`))
    .orderBy(desc(driveClaims.updatedAt));
  const schools = await schoolsOf(
    env,
    rows.map((r) => r.org),
  );
  return rows.map(({ claim, drive, org, book }) => ({
    ...claimJson(claim),
    book: { id: book.id, title: book.title, authors: book.authors, cover_url: coverUrlFor(env, origin, book) },
    drive: driveHead(drive, organizationDisplayName(schools.get(org.schoolId), org.name, lang), now),
  }));
}
