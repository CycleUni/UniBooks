/**
 * /api/v1/drives: book drives (收書贈書; docs/plans/2026-11-25-book-drive.md).
 *   ''                         GET  the drives this account runs or staffs (?organization=)
 *                              POST {organization, title, description}: an organization's admins
 *   <id>                       GET, PATCH {title, description, max_claims_per_user, member_priority, status}
 *   <id>/staff                 GET, POST {email}; <id>/staff/<user id> DELETE   (admins)
 *   <id>/copies                GET (?q=, ?status=, ?page=), POST: take a book in (while collecting)
 *   <id>/copies/<copy id>      PATCH, DELETE (a copy entered by mistake)
 *   <id>/students/<number>     GET: a donor's department and year, from the roster or earlier intakes
 * Admins of the drive's organization may do everything; its staff take books
 * in and correct them. Nobody else sees a drive (services/drives/access.ts).
 * The event system's back office calls these from the same origin.
 */
import { Hono, type Context } from 'hono';
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../env';
import {
  bookDrives,
  bookDriveStaff,
  books,
  createDb,
  driveCopies,
  organizationAdmins,
  organizationMembers,
  organizations,
  users,
  type BookDrive,
  type DriveCopy,
  type Organization,
} from '../db';
import { apiError, fieldErrors, pagination, readJson } from '../lib/http';
import { authMiddleware } from '../middleware/auth';
import { checkRate } from '../middleware/rateLimit';
import { normalizeStudentNumber } from '../lib/studentNumber';
import { UUID_RE } from '../lib/uuid';
import { nowIso } from '../lib/time';
import { writeAudit, changedFields } from '../services/admin/audit';
import { likeContains } from '../services/admin/scope';
import { resolveLanguage } from '../services/accounts/i18n';
import { displayName } from '../services/accounts/users';
import { coverUrlFor } from '../services/catalog/covers';
import { findOrCreateBook } from '../services/catalog/books';
import { regionCategories } from '../services/listings/places';
import { organizationDisplayName, requireOrgAdmin, schoolsOf } from '../services/orgs/organizations';
import { departmentField, gradeField, today } from '../services/orgs/roster';
import { assertCollecting, requireDrive, runsDrives, type DriveRole } from '../services/drives/access';

export const driveRoutes = new Hono<AppEnv>();

driveRoutes.use('*', authMiddleware());

const MAX_TITLE = 80;
const MAX_DESCRIPTION = 2000;
const MAX_NOTE = 200;
const MAX_CLAIMS = 20;
const CONDITIONS = ['new', 'like_new', 'noted', 'damaged'] as const;
/** Statuses an admin may set by hand now; the ones between (claiming, allocation, pickup) come with those phases. */
const SETTABLE_STATUSES = ['intake', 'closed'] as const;

function cleanText(v: unknown, field: string, max: number, required = false): string {
  const s = typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : null;
  if (s === null || s.length > max || (required && !s)) fieldErrors({ [field]: ['common.errValidation'] });
  return s;
}

// --- Drives ----------------------------------------------------------------

/** Drives with their organization's name, the viewer's role and their counts. */
async function driveView(c: Context<AppEnv>, rows: { drive: BookDrive; org: Organization; role: DriveRole }[]) {
  if (!rows.length) return [];
  const db = createDb(c.env.DB);
  const ids = rows.map((r) => r.drive.id);
  const [schools, lang, copyCounts, staffCounts] = await Promise.all([
    schoolsOf(
      c.env,
      rows.map((r) => r.org),
    ),
    resolveLanguage(c),
    db
      .select({
        driveId: driveCopies.driveId,
        total: count(),
        inStock: sql<number>`sum(${driveCopies.status} = 'in_stock')`,
        withdrawn: sql<number>`sum(${driveCopies.status} = 'withdrawn')`,
        titles: sql<number>`count(distinct ${driveCopies.bookId})`,
      })
      .from(driveCopies)
      .where(inArray(driveCopies.driveId, ids))
      .groupBy(driveCopies.driveId),
    db
      .select({ driveId: bookDriveStaff.driveId, n: count() })
      .from(bookDriveStaff)
      .where(inArray(bookDriveStaff.driveId, ids))
      .groupBy(bookDriveStaff.driveId),
  ]);
  const copies = new Map(copyCounts.map((r) => [r.driveId, r]));
  const staff = new Map(staffCounts.map((r) => [r.driveId, r.n]));
  return rows.map(({ drive: d, org, role }) => {
    const n = copies.get(d.id);
    return {
      id: d.id,
      organization: { id: org.id, display_name: organizationDisplayName(schools.get(org.schoolId), org.name, lang) },
      region: d.regionCode,
      title: d.title,
      description: d.description,
      status: d.status,
      max_claims_per_user: d.maxClaimsPerUser,
      member_priority: !!d.memberPriority,
      claim_opens_at: d.claimOpensAt,
      claim_closes_at: d.claimClosesAt,
      pickup_starts_at: d.pickupStartsAt,
      pickup_ends_at: d.pickupEndsAt,
      closed_at: d.closedAt,
      created_at: d.createdAt,
      role,
      counts: {
        copies: n?.total ?? 0,
        in_stock: Number(n?.inStock ?? 0),
        withdrawn: Number(n?.withdrawn ?? 0),
        titles: n?.titles ?? 0,
        staff: staff.get(d.id) ?? 0,
      },
    };
  });
}

driveRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const db = createDb(c.env.DB);
  const orgFilter = c.req.query('organization');
  const conds: (SQL | undefined)[] = [or(sql`${organizationAdmins.userId} IS NOT NULL`, sql`${bookDriveStaff.userId} IS NOT NULL`)];
  if (orgFilter) conds.push(eq(bookDrives.organizationId, orgFilter));
  const rows = await db
    .select({ drive: bookDrives, org: organizations, isAdmin: organizationAdmins.userId })
    .from(bookDrives)
    .innerJoin(organizations, runsDrives)
    .leftJoin(organizationAdmins, and(eq(organizationAdmins.organizationId, organizations.id), eq(organizationAdmins.userId, user.id)))
    .leftJoin(bookDriveStaff, and(eq(bookDriveStaff.driveId, bookDrives.id), eq(bookDriveStaff.userId, user.id)))
    .where(and(...conds))
    .orderBy(desc(bookDrives.createdAt));
  const results = await driveView(
    c,
    rows.map((r) => ({ drive: r.drive, org: r.org, role: (r.isAdmin ? 'admin' : 'staff') as DriveRole })),
  );
  return c.json({ results });
});

driveRoutes.post('/', async (c) => {
  const body = await readJson(c.req);
  const org = await requireOrgAdmin(c, typeof body.organization === 'string' ? body.organization : '');
  if (!org.drivesEnabled) apiError(403, 'org.errDrivesOff');
  const now = nowIso();
  const drive: BookDrive = {
    id: crypto.randomUUID(),
    organizationId: org.id,
    regionCode: org.regionCode,
    title: cleanText(body.title, 'title', MAX_TITLE, true),
    description: cleanText(body.description, 'description', MAX_DESCRIPTION),
    status: 'intake',
    claimOpensAt: null,
    claimClosesAt: null,
    pickupStartsAt: null,
    pickupEndsAt: null,
    maxClaimsPerUser: 3,
    memberPriority: 1,
    allocationSeed: null,
    allocatedAt: null,
    closedAt: null,
    nextShelfNo: 1,
    createdById: c.get('user')!.id,
    createdAt: now,
    updatedAt: now,
  };
  const db = createDb(c.env.DB);
  await db.insert(bookDrives).values(drive);
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'drive.created',
      meta: { organization_id: org.id, title: drive.title },
      targetType: 'book_drive',
      targetId: drive.id,
    },
    c,
  );
  const [view] = await driveView(c, [{ drive, org, role: 'admin' }]);
  return c.json(view, 201);
});

driveRoutes.get('/:id', async (c) => {
  const access = await requireDrive(c, c.req.param('id'), 'staff');
  const [view] = await driveView(c, [access]);
  return c.json(view);
});

driveRoutes.patch('/:id', async (c) => {
  const { drive, org } = await requireDrive(c, c.req.param('id'), 'admin');
  const body = await readJson(c.req);
  const set: Partial<BookDrive> = {};
  if ('title' in body) set.title = cleanText(body.title, 'title', MAX_TITLE, true);
  if ('description' in body) set.description = cleanText(body.description, 'description', MAX_DESCRIPTION);
  if ('max_claims_per_user' in body) {
    const n = body.max_claims_per_user;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CLAIMS)
      fieldErrors({ max_claims_per_user: ['common.errValidation'] });
    set.maxClaimsPerUser = n;
  }
  if ('member_priority' in body) {
    if (typeof body.member_priority !== 'boolean') fieldErrors({ member_priority: ['common.errValidation'] });
    set.memberPriority = body.member_priority ? 1 : 0;
  }
  if ('status' in body && body.status !== drive.status) {
    const status = SETTABLE_STATUSES.find((s) => s === body.status);
    if (!status) fieldErrors({ status: ['common.errValidation'] });
    set.status = status;
    set.closedAt = status === 'closed' ? nowIso() : null;
  }
  const db = createDb(c.env.DB);
  if (Object.keys(set).length) {
    const changes = changedFields(drive, set);
    set.updatedAt = nowIso();
    await db.update(bookDrives).set(set).where(eq(bookDrives.id, drive.id));
    await writeAudit(
      db,
      { actorId: c.get('user')!.id, kind: 'drive.updated', meta: { changes }, targetType: 'book_drive', targetId: drive.id },
      c,
    );
  }
  const [view] = await driveView(c, [{ drive: { ...drive, ...set }, org, role: 'admin' }]);
  return c.json(view);
});

// --- Staff -----------------------------------------------------------------

async function staffList(c: Context<AppEnv>, driveId: string) {
  const rows = await createDb(c.env.DB)
    .select({ id: users.id, email: users.email, first: users.firstName, last: users.lastName })
    .from(bookDriveStaff)
    .innerJoin(users, eq(users.id, bookDriveStaff.userId))
    .where(eq(bookDriveStaff.driveId, driveId))
    .orderBy(asc(bookDriveStaff.createdAt));
  return { results: rows.map((u) => ({ id: u.id, email: u.email, display_name: displayName(u.first, u.last) })) };
}

driveRoutes.get('/:id/staff', async (c) => {
  const { drive } = await requireDrive(c, c.req.param('id'), 'admin');
  return c.json(await staffList(c, drive.id));
});

driveRoutes.post('/:id/staff', async (c) => {
  const { drive } = await requireDrive(c, c.req.param('id'), 'admin');
  const body = await readJson(c.req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) fieldErrors({ email: ['common.errValidation'] });
  const db = createDb(c.env.DB);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || user.deletedAt || !user.isActive || user.isBanned) apiError(404, 'drive.errStaffNotFound');
  await db
    .insert(bookDriveStaff)
    .values({ driveId: drive.id, userId: user.id, addedById: c.get('user')!.id, createdAt: nowIso() })
    .onConflictDoNothing();
  await writeAudit(
    db,
    { actorId: c.get('user')!.id, kind: 'drive.staff_added', meta: { user_id: user.id }, targetType: 'book_drive', targetId: drive.id },
    c,
  );
  return c.json(await staffList(c, drive.id));
});

driveRoutes.delete('/:id/staff/:userId', async (c) => {
  const { drive } = await requireDrive(c, c.req.param('id'), 'admin');
  const userId = c.req.param('userId');
  const db = createDb(c.env.DB);
  const res = await db
    .delete(bookDriveStaff)
    .where(and(eq(bookDriveStaff.driveId, drive.id), eq(bookDriveStaff.userId, userId)))
    .run();
  if (!res.meta.changes) apiError(404, 'common.errNotFound');
  await writeAudit(
    db,
    { actorId: c.get('user')!.id, kind: 'drive.staff_removed', meta: { user_id: userId }, targetType: 'book_drive', targetId: drive.id },
    c,
  );
  return c.json(await staffList(c, drive.id));
});

// --- Copies ----------------------------------------------------------------

/** Copies with their books and who took them in. */
async function copyView(c: Context<AppEnv>, rows: DriveCopy[]) {
  if (!rows.length) return [];
  const db = createDb(c.env.DB);
  const bookIds = [...new Set(rows.map((r) => r.bookId))];
  const userIds = [...new Set(rows.map((r) => r.intakeById).filter((x): x is string => !!x))];
  const [bookRows, userRows] = await Promise.all([
    db.select().from(books).where(inArray(books.id, bookIds)),
    userIds.length
      ? db.select({ id: users.id, first: users.firstName, last: users.lastName }).from(users).where(inArray(users.id, userIds))
      : Promise.resolve([]),
  ]);
  const bookMap = new Map(bookRows.map((b) => [b.id, b]));
  const userMap = new Map(userRows.map((u) => [u.id, displayName(u.first, u.last)]));
  const origin = new URL(c.req.url).origin;
  return rows.map((r) => {
    const b = bookMap.get(r.bookId);
    return {
      id: r.id,
      shelf_no: r.shelfNo,
      book: b ? { id: b.id, title: b.title, authors: b.authors, isbn13: b.isbn13, cover_url: coverUrlFor(c.env, origin, b) } : null,
      condition: r.condition,
      donor_student_number: r.donorStudentNumber,
      donor_department: r.donorDepartment,
      target_department: r.targetDepartment,
      target_grade: r.targetGrade,
      status: r.status,
      note: r.note,
      intake_by: r.intakeById ? (userMap.get(r.intakeById) ?? '') : '',
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  });
}

interface CopyFields {
  condition?: DriveCopy['condition'];
  donorStudentNumber?: string;
  donorDepartment?: string;
  targetDepartment?: string;
  targetGrade?: number | null;
  note?: string;
}

/** The copy fields a body names, checked; departments filed under the region's names. `warnings` for departments kept as typed. */
async function copyFields(c: Context<AppEnv>, drive: BookDrive, body: Record<string, unknown>, creating: boolean) {
  const errors: Record<string, string[]> = {};
  const warnings: string[] = [];
  const out: CopyFields = {};
  if (creating || 'condition' in body) {
    const condition = CONDITIONS.find((x) => x === body.condition);
    if (!condition) errors.condition = ['drive.errCondition'];
    out.condition = condition;
  }
  if ('donor_student_number' in body) {
    const raw = body.donor_student_number;
    if (raw === '' || raw === null) out.donorStudentNumber = '';
    else {
      const n = normalizeStudentNumber(raw);
      if (!n) errors.donor_student_number = ['org.errStudentNumber'];
      out.donorStudentNumber = n ?? '';
    }
  }
  const cats = await regionCategories(c.env, drive.regionCode);
  for (const [field, key] of [
    ['donor_department', 'donorDepartment'],
    ['target_department', 'targetDepartment'],
  ] as const) {
    if (!(field in body)) continue;
    const d = departmentField(cats, body[field]);
    if (!d) errors[field] = ['org.errDepartment'];
    else {
      out[key] = d.value;
      if (d.unlisted && !warnings.includes('org.warnDepartmentUnlisted')) warnings.push('org.warnDepartmentUnlisted');
    }
  }
  if ('target_grade' in body) {
    const g = gradeField(body.target_grade);
    if (g === undefined) errors.target_grade = ['org.errGrade'];
    out.targetGrade = g ?? null;
  }
  if ('note' in body) out.note = cleanText(body.note, 'note', MAX_NOTE);
  if (Object.keys(errors).length) fieldErrors(errors);
  return { fields: out, warnings };
}

driveRoutes.get('/:id/copies', async (c) => {
  const { drive } = await requireDrive(c, c.req.param('id'), 'staff');
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url, { pageSize: 50, allowPageSize: true, maxPageSize: 200 });
  const conds: (SQL | undefined)[] = [eq(driveCopies.driveId, drive.id)];
  const status = c.req.query('status');
  if (status) conds.push(eq(driveCopies.status, status as DriveCopy['status']));
  const q = (c.req.query('q') ?? '').trim();
  if (q) {
    const contains = likeContains(q);
    const shelf = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
    conds.push(
      or(
        sql`${books.title} LIKE ${contains} ESCAPE '\\'`,
        sql`${books.isbn13} LIKE ${contains} ESCAPE '\\'`,
        eq(driveCopies.donorStudentNumber, q.toUpperCase()),
        shelf !== null ? eq(driveCopies.shelfNo, shelf) : undefined,
      ),
    );
  }
  const where = and(...conds);
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(driveCopies).innerJoin(books, eq(books.id, driveCopies.bookId)).where(where),
    db
      .select({ copy: driveCopies })
      .from(driveCopies)
      .innerJoin(books, eq(books.id, driveCopies.bookId))
      .where(where)
      .orderBy(desc(driveCopies.shelfNo))
      .limit(page.limit)
      .offset(page.offset),
  ]);
  return c.json(
    page.wrap(
      await copyView(
        c,
        rows.map((r) => r.copy),
      ),
      total,
    ),
  );
});

driveRoutes.post('/:id/copies', async (c) => {
  const { drive } = await requireDrive(c, c.req.param('id'), 'staff');
  assertCollecting(drive);
  // A booth takes in books fast, but not this fast.
  await checkRate(c, 'drive_intake', '600/hour');
  const body = await readJson(c.req);
  const { fields, warnings } = await copyFields(c, drive, body, true);

  const db = createDb(c.env.DB);
  let bookId: string;
  if (typeof body.book_id === 'string') {
    const [b] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, body.book_id.toLowerCase()), eq(books.regionCode, drive.regionCode)))
      .limit(1);
    if (!b || !UUID_RE.test(body.book_id)) fieldErrors({ book_id: ['common.errNotFound'] });
    bookId = b.id;
  } else {
    const bookBody = body.book && typeof body.book === 'object' && !Array.isArray(body.book) ? (body.book as Record<string, unknown>) : {};
    const { book } = await findOrCreateBook(c.env, drive.regionCode, bookBody, {
      isAdmin: c.get('user')!.isAdmin,
      origin: new URL(c.req.url).origin,
    });
    bookId = book.id;
  }

  // The shelf number and the copy in one transaction: the copy takes the
  // drive's next number, which then moves on. Nothing is written once the drive stopped collecting.
  const id = crypto.randomUUID();
  const now = nowIso();
  const [inserted] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO drive_copies (id, drive_id, book_id, shelf_no, condition, donor_student_number, donor_department,
                                 target_department, target_grade, status, note, intake_by_id, created_at, updated_at)
       SELECT ?1, d.id, ?2, d.next_shelf_no, ?3, ?4, ?5, ?6, ?7, 'in_stock', ?8, ?9, ?10, ?10
         FROM book_drives d WHERE d.id = ?11 AND d.status = 'intake'`,
    ).bind(
      id,
      bookId,
      fields.condition!,
      fields.donorStudentNumber ?? '',
      fields.donorDepartment ?? '',
      fields.targetDepartment ?? '',
      fields.targetGrade ?? null,
      fields.note ?? '',
      c.get('user')!.id,
      now,
      drive.id,
    ),
    c.env.DB.prepare(`UPDATE book_drives SET next_shelf_no = next_shelf_no + 1 WHERE id = ?1 AND changes() > 0`).bind(drive.id),
  ]);
  if (!inserted.meta.changes) apiError(400, 'drive.errNotCollecting');
  const [copy] = await db.select().from(driveCopies).where(eq(driveCopies.id, id));
  const [view] = await copyView(c, [copy]);
  return c.json({ ...view, warnings }, 201);
});

async function findCopy(c: Context<AppEnv>, drive: BookDrive): Promise<DriveCopy> {
  const [copy] = await createDb(c.env.DB)
    .select()
    .from(driveCopies)
    .where(and(eq(driveCopies.id, c.req.param('copyId') ?? ''), eq(driveCopies.driveId, drive.id)))
    .limit(1);
  if (!copy) apiError(404, 'common.errNotFound');
  return copy;
}

driveRoutes.patch('/:id/copies/:copyId', async (c) => {
  const { drive } = await requireDrive(c, c.req.param('id'), 'staff');
  const copy = await findCopy(c, drive);
  const body = await readJson(c.req);
  const { fields, warnings } = await copyFields(c, drive, body, false);
  const set: Partial<DriveCopy> = { ...fields };
  if ('status' in body && body.status !== copy.status) {
    // Only a book on the shelf may be withdrawn (damaged, lost) or put back; one promised to a student is not.
    const ok = (copy.status === 'in_stock' && body.status === 'withdrawn') || (copy.status === 'withdrawn' && body.status === 'in_stock');
    if (!ok) apiError(400, 'drive.errCopyNotOnShelf');
    set.status = body.status as DriveCopy['status'];
  }
  const db = createDb(c.env.DB);
  const changes = changedFields(copy, set);
  if (Object.keys(changes).length) {
    set.updatedAt = nowIso();
    const res = await db
      .update(driveCopies)
      .set(set)
      .where(and(eq(driveCopies.id, copy.id), eq(driveCopies.status, copy.status)))
      .run();
    if (!res.meta.changes) apiError(409, 'drive.errCopyChanged');
    await writeAudit(
      db,
      {
        actorId: c.get('user')!.id,
        kind: 'drive.copy_updated',
        meta: { shelf_no: copy.shelfNo, changes },
        targetType: 'book_drive',
        targetId: drive.id,
      },
      c,
    );
  }
  const [view] = await copyView(c, [{ ...copy, ...set }]);
  return c.json({ ...view, warnings });
});

driveRoutes.delete('/:id/copies/:copyId', async (c) => {
  const { drive } = await requireDrive(c, c.req.param('id'), 'staff');
  const copy = await findCopy(c, drive);
  const db = createDb(c.env.DB);
  // Taken in by mistake: removable while nobody has it; a book promised to a student stays on record.
  const res = await db
    .delete(driveCopies)
    .where(and(eq(driveCopies.id, copy.id), inArray(driveCopies.status, ['in_stock', 'withdrawn'])))
    .run();
  if (!res.meta.changes) apiError(400, 'drive.errCopyNotOnShelf');
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'drive.copy_deleted',
      meta: { shelf_no: copy.shelfNo, book_id: copy.bookId },
      targetType: 'book_drive',
      targetId: drive.id,
    },
    c,
  );
  return c.body(null, 204);
});

// --- Donors ----------------------------------------------------------------

/**
 * What intake can fill in for a donor's student number: the department and
 * year from the organization's roster (a current member), else the department
 * an earlier intake of the organization recorded. The name never: staff see
 * only what they type in.
 */
driveRoutes.get('/:id/students/:number', async (c) => {
  const { drive } = await requireDrive(c, c.req.param('id'), 'staff');
  const number = normalizeStudentNumber(c.req.param('number'));
  if (!number) fieldErrors({ number: ['org.errStudentNumber'] });
  const db = createDb(c.env.DB);
  const [member] = await db
    .select({ department: organizationMembers.department, grade: organizationMembers.grade })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, drive.organizationId),
        eq(organizationMembers.studentNumber, number),
        sql`${organizationMembers.validUntil} >= ${today()}`,
      ),
    )
    .limit(1);
  if (member && (member.department || member.grade)) {
    return c.json({ student_number: number, department: member.department, grade: member.grade, source: 'roster' });
  }
  const [earlier] = await db
    .select({ department: driveCopies.donorDepartment })
    .from(driveCopies)
    .innerJoin(bookDrives, eq(bookDrives.id, driveCopies.driveId))
    .where(
      and(
        eq(bookDrives.organizationId, drive.organizationId),
        eq(driveCopies.donorStudentNumber, number),
        sql`${driveCopies.donorDepartment} != ''`,
      ),
    )
    .orderBy(desc(driveCopies.createdAt))
    .limit(1);
  if (earlier) return c.json({ student_number: number, department: earlier.department, grade: null, source: 'history' });
  return c.json({ student_number: number, department: '', grade: null, source: null });
});
