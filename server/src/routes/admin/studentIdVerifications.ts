import { isUniqueViolation } from '../../lib/db';
import { Hono, type Context } from 'hono';
import { and, desc, eq, ne, sql, count, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { createDb, schools, studentIdVerifications, userSchools, users } from '../../db';
import { apiError, pagination, readJson } from '../../lib/http';
import { writeAudit } from '../../services/admin/audit';
import { assertInScope, scopeOf, scopeWhere } from '../../services/admin/scope';
import { upsertStudentIdVerification } from '../../services/accounts/edu';

export const studentIdVerificationRoutes = new Hono<AppEnv>();

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

studentIdVerificationRoutes.get('/student-id-verifications', async (c) => {
  const db = createDb(c.env.DB);
  const scope = await scopeOf(c);
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });

  const conds: (SQL | undefined)[] = [];
  const scopeCond = scopeWhere(studentIdVerifications.regionCode, scope);
  if (scopeCond) conds.push(scopeCond);

  const status = c.req.query('status');
  if (status && STATUSES.includes(status as (typeof STATUSES)[number])) {
    conds.push(eq(studentIdVerifications.status, status as (typeof STATUSES)[number]));
  }

  const school = c.req.query('school');
  if (school) {
    conds.push(eq(schools.code, school.trim().toUpperCase()));
  }

  const region = c.req.query('region');
  if (region) {
    const code = region.trim().toUpperCase();
    assertInScope(scope, code);
    conds.push(eq(studentIdVerifications.regionCode, code));
  }

  const where = and(...conds);

  // Total count matching query
  const [{ total }] = await db
    .select({ total: count() })
    .from(studentIdVerifications)
    .leftJoin(schools, eq(schools.id, studentIdVerifications.schoolId))
    .where(where);

  // Pending count for the nav badge within scoped regions
  const pendingConds: (SQL | undefined)[] = [eq(studentIdVerifications.status, 'pending')];
  if (scopeCond) pendingConds.push(scopeCond);
  const [{ pendingTotal }] = await db
    .select({ pendingTotal: count() })
    .from(studentIdVerifications)
    .where(and(...pendingConds));

  const rows = await db
    .select({
      id: studentIdVerifications.id,
      region: studentIdVerifications.regionCode,
      status: studentIdVerifications.status,
      student_number: studentIdVerifications.studentNumber,
      reject_reason: studentIdVerifications.rejectReason,
      has_image: sql<number>`CASE WHEN ${studentIdVerifications.imageKey} IS NOT NULL THEN 1 ELSE 0 END`,
      created_at: studentIdVerifications.createdAt,
      updated_at: studentIdVerifications.updatedAt,
      reviewed_at: studentIdVerifications.reviewedAt,
      reviewed_by_id: studentIdVerifications.reviewedById,
      school: {
        id: schools.id,
        code: schools.code,
        name: schools.name,
      },
      user: {
        id: users.id,
        email: users.email,
        first_name: users.firstName,
        last_name: users.lastName,
      },
    })
    .from(studentIdVerifications)
    .innerJoin(users, eq(users.id, studentIdVerifications.userId))
    .innerJoin(schools, eq(schools.id, studentIdVerifications.schoolId))
    .where(where)
    .orderBy(desc(studentIdVerifications.createdAt), desc(studentIdVerifications.id))
    .limit(page.limit)
    .offset(page.offset);

  return c.json({
    ...page.wrap(
      rows.map((r) => ({
        ...r,
        has_image: Boolean(r.has_image),
      })),
      total,
    ),
    pending_count: pendingTotal,
  });
});

studentIdVerificationRoutes.get('/student-id-verifications/:id', async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const scope = await scopeOf(c);

  const [row] = await db
    .select({
      id: studentIdVerifications.id,
      userId: studentIdVerifications.userId,
      regionCode: studentIdVerifications.regionCode,
      schoolId: studentIdVerifications.schoolId,
      studentNumber: studentIdVerifications.studentNumber,
      imageKey: studentIdVerifications.imageKey,
      status: studentIdVerifications.status,
      rejectReason: studentIdVerifications.rejectReason,
      reviewedById: studentIdVerifications.reviewedById,
      reviewedAt: studentIdVerifications.reviewedAt,
      createdAt: studentIdVerifications.createdAt,
      updatedAt: studentIdVerifications.updatedAt,
      schoolCode: schools.code,
      schoolName: schools.name,
      userEmail: users.email,
      userFirstName: users.firstName,
      userLastName: users.lastName,
    })
    .from(studentIdVerifications)
    .innerJoin(users, eq(users.id, studentIdVerifications.userId))
    .innerJoin(schools, eq(schools.id, studentIdVerifications.schoolId))
    .where(eq(studentIdVerifications.id, id))
    .limit(1);

  if (!row) apiError(404, 'common.errNotFound');
  assertInScope(scope, row.regionCode);

  // User's declared school
  const [userSchoolRow] = await db
    .select({
      code: schools.code,
      name: schools.name,
    })
    .from(userSchools)
    .innerJoin(schools, eq(schools.id, userSchools.schoolId))
    .where(and(eq(userSchools.userId, row.userId), eq(userSchools.regionCode, row.regionCode)))
    .limit(1);

  // Previous requests of the same user in this region
  const previousRequests = await db
    .select({
      id: studentIdVerifications.id,
      status: studentIdVerifications.status,
      student_number: studentIdVerifications.studentNumber,
      reject_reason: studentIdVerifications.rejectReason,
      created_at: studentIdVerifications.createdAt,
      reviewed_at: studentIdVerifications.reviewedAt,
      school_code: schools.code,
      school_name: schools.name,
    })
    .from(studentIdVerifications)
    .innerJoin(schools, eq(schools.id, studentIdVerifications.schoolId))
    .where(and(eq(studentIdVerifications.userId, row.userId), ne(studentIdVerifications.id, row.id)))
    .orderBy(desc(studentIdVerifications.createdAt));

  // Any other account that used the same student number at that school
  const otherAccounts = await db
    .select({
      id: studentIdVerifications.id,
      user_id: users.id,
      email: users.email,
      first_name: users.firstName,
      last_name: users.lastName,
      status: studentIdVerifications.status,
      created_at: studentIdVerifications.createdAt,
    })
    .from(studentIdVerifications)
    .innerJoin(users, eq(users.id, studentIdVerifications.userId))
    .where(
      and(
        eq(studentIdVerifications.schoolId, row.schoolId),
        eq(studentIdVerifications.studentNumber, row.studentNumber),
        ne(studentIdVerifications.userId, row.userId),
      ),
    )
    .orderBy(desc(studentIdVerifications.createdAt));

  return c.json({
    id: row.id,
    region: row.regionCode,
    status: row.status,
    student_number: row.studentNumber,
    reject_reason: row.rejectReason,
    has_image: Boolean(row.imageKey),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    reviewed_at: row.reviewedAt,
    reviewed_by_id: row.reviewedById,
    school: {
      id: row.schoolId,
      code: row.schoolCode,
      name: row.schoolName,
    },
    user: {
      id: row.userId,
      email: row.userEmail,
      first_name: row.userFirstName,
      last_name: row.userLastName,
      declared_school: userSchoolRow ?? null,
    },
    previous_requests: previousRequests,
    other_accounts_same_student_number: otherAccounts,
  });
});

studentIdVerificationRoutes.get('/student-id-verifications/:id/image', async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const scope = await scopeOf(c);

  const [row] = await db
    .select({
      regionCode: studentIdVerifications.regionCode,
      imageKey: studentIdVerifications.imageKey,
    })
    .from(studentIdVerifications)
    .where(eq(studentIdVerifications.id, id))
    .limit(1);

  if (!row) apiError(404, 'common.errNotFound');
  assertInScope(scope, row.regionCode);
  if (!row.imageKey) apiError(404, 'common.errNotFound');

  const obj = await c.env.R2_PRIVATE.get(row.imageKey);
  if (!obj) apiError(404, 'common.errNotFound');

  const headers = new Headers();
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");

  return new Response(obj.body, { headers });
});

/**
 * Delete the photo of a request that was just decided. If R2 refuses, the key
 * goes back on the row (the row already says image_key = NULL) so the daily
 * cleanup still knows there is a photo to remove: a lost key would leave a
 * student's card in the bucket with nothing pointing at it.
 */
async function deleteDecidedImage(c: Context<AppEnv>, id: string, imageKey: string | null): Promise<void> {
  if (!imageKey) return;
  try {
    await c.env.R2_PRIVATE.delete(imageKey);
  } catch (e) {
    console.error('[admin] failed to delete a decided student ID photo; left for the cleanup job', e);
    await createDb(c.env.DB)
      .update(studentIdVerifications)
      .set({ imageKey })
      .where(eq(studentIdVerifications.id, id))
      .run()
      .catch(() => undefined);
  }
}

studentIdVerificationRoutes.post('/student-id-verifications/:id/approve', async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const scope = await scopeOf(c);
  const staff = c.get('user')!;

  const [row] = await db.select().from(studentIdVerifications).where(eq(studentIdVerifications.id, id)).limit(1);

  if (!row) apiError(404, 'common.errNotFound');
  assertInScope(scope, row.regionCode);

  if (row.status !== 'pending') {
    apiError(400, 'admin.errAlreadyDecided');
  }

  // A student number may be APPROVED for only one account per school
  const [otherApproved] = await db
    .select({ id: studentIdVerifications.id })
    .from(studentIdVerifications)
    .where(
      and(
        eq(studentIdVerifications.schoolId, row.schoolId),
        eq(studentIdVerifications.studentNumber, row.studentNumber),
        eq(studentIdVerifications.status, 'approved'),
        ne(studentIdVerifications.userId, row.userId),
      ),
    )
    .limit(1);

  if (otherApproved) {
    apiError(400, 'admin.errStudentNumberAlreadyApproved');
  }

  const now = new Date().toISOString();

  // Atomic conditional update WHERE status = 'pending'
  let res;
  try {
    res = await db
      .update(studentIdVerifications)
      .set({
        status: 'approved',
        imageKey: null,
        reviewedById: staff.id,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(and(eq(studentIdVerifications.id, row.id), eq(studentIdVerifications.status, 'pending')))
      .run();
  } catch (e) {
    // Two requests with the same number approved at once: the partial unique index kept one.
    if (isUniqueViolation(e)) apiError(400, 'admin.errStudentNumberAlreadyApproved');
    throw e;
  }

  if (res.meta.changes === 0) {
    apiError(409, 'admin.errAlreadyDecided');
  }

  // Delete image object in the SAME request
  await deleteDecidedImage(c, row.id, row.imageKey);

  // Approve creates/renews region_verifications row and user_schools
  await upsertStudentIdVerification(c.env, row.userId, row.regionCode, row.schoolId, row.studentNumber);

  // Write audit event
  await writeAudit(
    db,
    {
      actorId: staff.id,
      kind: 'admin.student_id_approved',
      meta: {
        student_id_verification_id: row.id,
        user_id: row.userId,
        region_code: row.regionCode,
        school_id: row.schoolId,
        student_number: row.studentNumber,
      },
      targetType: 'student_id_verification',
      targetId: row.id,
    },
    c,
  );

  // Enqueue outcome email
  const [school] = await db
    .select({ name: schools.name, translations: schools.translations })
    .from(schools)
    .where(eq(schools.id, row.schoolId))
    .limit(1);
  await c.env.EMAIL_QUEUE.send({
    type: 'student_id_verification_outcome',
    user_id: row.userId,
    region: row.regionCode,
    school_name: school?.name || '',
    school_translations: school?.translations,
    status: 'approved',
  }).catch((e) => console.error('[admin] failed to enqueue approved email', e));

  return c.json({
    id: row.id,
    status: 'approved',
    reviewed_at: now,
  });
});

studentIdVerificationRoutes.post('/student-id-verifications/:id/reject', async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const scope = await scopeOf(c);
  const staff = c.get('user')!;

  const [row] = await db.select().from(studentIdVerifications).where(eq(studentIdVerifications.id, id)).limit(1);

  if (!row) apiError(404, 'common.errNotFound');
  assertInScope(scope, row.regionCode);

  if (row.status !== 'pending') {
    apiError(400, 'admin.errAlreadyDecided');
  }

  const body = await readJson(c.req);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 500) {
    apiError(400, 'admin.errReasonRequired');
  }

  const now = new Date().toISOString();

  // Atomic conditional update WHERE status = 'pending'
  const res = await db
    .update(studentIdVerifications)
    .set({
      status: 'rejected',
      rejectReason: reason,
      imageKey: null,
      reviewedById: staff.id,
      reviewedAt: now,
      updatedAt: now,
    })
    .where(and(eq(studentIdVerifications.id, row.id), eq(studentIdVerifications.status, 'pending')))
    .run();

  if (res.meta.changes === 0) {
    apiError(409, 'admin.errAlreadyDecided');
  }

  // Delete image object in the SAME request
  await deleteDecidedImage(c, row.id, row.imageKey);

  // Write audit event
  await writeAudit(
    db,
    {
      actorId: staff.id,
      kind: 'admin.student_id_rejected',
      meta: {
        student_id_verification_id: row.id,
        user_id: row.userId,
        region_code: row.regionCode,
        school_id: row.schoolId,
        student_number: row.studentNumber,
        reason,
      },
      targetType: 'student_id_verification',
      targetId: row.id,
    },
    c,
  );

  // Enqueue outcome email
  const [school] = await db
    .select({ name: schools.name, translations: schools.translations })
    .from(schools)
    .where(eq(schools.id, row.schoolId))
    .limit(1);
  await c.env.EMAIL_QUEUE.send({
    type: 'student_id_verification_outcome',
    user_id: row.userId,
    region: row.regionCode,
    school_name: school?.name || '',
    school_translations: school?.translations,
    status: 'rejected',
    reason,
  }).catch((e) => console.error('[admin] failed to enqueue rejected email', e));

  return c.json({
    id: row.id,
    status: 'rejected',
    reject_reason: reason,
    reviewed_at: now,
  });
});
