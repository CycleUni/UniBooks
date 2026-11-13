import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, regionVerifications, studentIdVerifications, userSchools } from '../../src/db';
import { eq, and } from 'drizzle-orm';
import { call, createUser, login, seedReference } from './helpers';
import { purgeExpiredStudentIdVerifications } from '../../src/jobs';
import { deleteAccount } from '../../src/services/accounts/users';

describe('Student ID Verification', () => {
  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

  beforeEach(async () => {
    await seedReference();
    // Add school with allows_student_id_verification = 1 (Chihlee / CLUT)
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO schools (id, region_code, code, name, email_domain, translations, allows_student_id_verification, is_active, created_at)
       VALUES (10, 'TW', 'CLUT', 'Chihlee University of Technology', 'mail.chihlee.edu.tw', '{}', 1, 1, ?)`,
    )
      .bind(now)
      .run();
  });

  it('handles two-step upload flow via PUT /verify/student-id/uploads/file', async () => {
    const user = await createUser('student-upload@example.com');
    const { access: token } = await login('student-upload@example.com');

    // Step 1: get upload URL
    const initRes = await call('/api/v1/auth/verify/student-id/uploads', {
      token,
      body: { content_type: 'image/jpeg', content_length: JPEG_BYTES.byteLength, school: 'CLUT' },
    });
    expect(initRes.status).toBe(200);
    const { upload_url, photo_url } = (await initRes.json()) as { upload_url: string; photo_url: string };
    expect(upload_url).toContain('/api/v1/auth/verify/student-id/uploads/file?token=');
    expect(photo_url).toMatch(new RegExp(`^tmp/student-ids/${user}/`));

    // Step 2: PUT file
    const parsed = new URL(upload_url);
    const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
    const putRes = await worker.fetch(
      new Request(`http://x${parsed.pathname}${parsed.search}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: JPEG_BYTES,
      }),
    );
    expect(putRes.status).toBe(200);

    // Verify file is in R2_PRIVATE
    const storedObj = await env.R2_PRIVATE.get(photo_url);
    expect(storedObj).not.toBeNull();

    // Step 3: submit verification
    const submitRes = await call('/api/v1/auth/verify/student-id', {
      token,
      body: { school: 'CLUT', student_number: 'C10904444', image: photo_url },
    });
    expect(submitRes.status).toBe(200);
    const submitJson = (await submitRes.json()) as { id: string; status: string };
    expect(submitJson.status).toBe('pending');
  });

  it('enforces eligibility matrix (school switch, live verification, pending request)', async () => {
    const userA = await createUser('student-a@example.com');
    const { access: tokenA } = await login('student-a@example.com');

    // School NTU has allows_student_id_verification = 0
    const resNTU = await call('/api/v1/auth/verify/student-id', {
      token: tokenA,
      body: { school: 'NTU', student_number: 'B10901001', image: `tmp/student-ids/${userA}/dummy.jpg` },
    });
    expect(resNTU.status).toBe(400);
    const ntuJson = (await resNTU.json()) as { error: { code: string } };
    expect(ntuJson.error.code).toBe('acct.errStudentIdVerificationNotAllowed');

    // Unknown school
    const resUnknown = await call('/api/v1/auth/verify/student-id', {
      token: tokenA,
      body: { school: 'UNKNOWN', student_number: 'B10901001', image: `tmp/student-ids/${userA}/dummy.jpg` },
    });
    expect(resUnknown.status).toBe(400);

    // Invalid student number (contains invalid characters or length < 4)
    const resBadNum = await call('/api/v1/auth/verify/student-id', {
      token: tokenA,
      body: { school: 'CLUT', student_number: '12', image: `tmp/student-ids/${userA}/dummy.jpg` },
    });
    expect(resBadNum.status).toBe(400);
    const badNumJson = (await resBadNum.json()) as { error: { code: string } };
    expect(badNumJson.error.code).toBe('acct.errInvalidStudentNumber');

    // Put a dummy tmp image directly in R2_PRIVATE to test user submission
    const tmpKey = `tmp/student-ids/${userA}/test.jpg`;
    await env.R2_PRIVATE.put(tmpKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    // Submit valid request
    const submitRes = await call('/api/v1/auth/verify/student-id', {
      token: tokenA,
      body: { school: 'CLUT', student_number: 'C10901001', image: tmpKey },
    });
    expect(submitRes.status).toBe(200);
    const submitJson = (await submitRes.json()) as { id: string; status: string; school: string; student_number: string };
    expect(submitJson.status).toBe('pending');
    expect(submitJson.school).toBe('CLUT');
    expect(submitJson.student_number).toBe('C10901001');

    // Verify temp object was moved to permanent key
    expect(await env.R2_PRIVATE.get(tmpKey)).toBeNull();
    const db = createDb(env.DB);
    const [row] = await db.select().from(studentIdVerifications).where(eq(studentIdVerifications.id, submitJson.id));
    expect(row).toBeDefined();
    expect(row.imageKey).toMatch(/^student-ids\/[a-f0-9-]+\/[a-f0-9-]+\.jpg$/);
    expect(await env.R2_PRIVATE.get(row.imageKey!)).not.toBeNull();

    // While pending, another submission is refused
    const resPending = await call('/api/v1/auth/verify/student-id', {
      token: tokenA,
      body: { school: 'CLUT', student_number: 'C10901002', image: tmpKey },
    });
    expect(resPending.status).toBe(400);
    const pendingJson = (await resPending.json()) as { error: { code: string } };
    expect(pendingJson.error.code).toBe('acct.errVerificationPending');

    // User can cancel pending request
    const cancelRes = await call('/api/v1/auth/verify/student-id', {
      method: 'DELETE',
      token: tokenA,
    });
    expect(cancelRes.status).toBe(200);

    // Image in R2_PRIVATE should now be deleted
    expect(await env.R2_PRIVATE.get(row.imageKey!)).toBeNull();

    // After cancellation, status in GET is cancelled
    const getRes = await call('/api/v1/auth/verify/student-id', { token: tokenA });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as { request: { status: string; school: string } };
    expect(getJson.request.status).toBe('cancelled');

    // Now mark user as verified in TW; live verification should refuse student ID submission
    const nowIso = new Date().toISOString();
    await db.insert(regionVerifications).values({
      userId: userA,
      regionCode: 'TW',
      schoolId: 10,
      isManualVerification: 1,
      method: 'staff',
      verifiedAt: nowIso,
      isActive: 1,
    });

    const resVerified = await call('/api/v1/auth/verify/student-id', {
      token: tokenA,
      body: { school: 'CLUT', student_number: 'C10901001', image: tmpKey },
    });
    expect(resVerified.status).toBe(400);
    const verifiedJson = (await resVerified.json()) as { error: { code: string } };
    expect(verifiedJson.error.code).toBe('acct.errAlreadyVerified');
  });

  it('refuses upload references owned by another user', async () => {
    await createUser('student-a2@example.com');
    const userB = await createUser('student-b2@example.com');
    const { access: tokenA } = await login('student-a2@example.com');

    // Put image under userB's prefix
    const userBKey = `tmp/student-ids/${userB}/b-photo.jpg`;
    await env.R2_PRIVATE.put(userBKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    // UserA tries to claim userB's upload
    const stealRes = await call('/api/v1/auth/verify/student-id', {
      token: tokenA,
      body: { school: 'CLUT', student_number: 'C10901002', image: userBKey },
    });
    expect(stealRes.status).toBe(403);

    // UserB's image is untouched
    expect(await env.R2_PRIVATE.get(userBKey)).not.toBeNull();
  });

  it('ensures private bucket is not reachable via any public route', async () => {
    const userA = await createUser('student-private@example.com');
    const { access: tokenA } = await login('student-private@example.com');

    const permKey = `student-ids/${userA}/secret.jpg`;
    await env.R2_PRIVATE.put(permKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    // Attempting to fetch through public /api/media should be 404
    const mediaRes = await call(`/api/media/${permKey}`);
    expect(mediaRes.status).toBe(404);

    // GET /api/v1/auth/verify/student-id never returns the image or image key
    const db = createDb(env.DB);
    const now = new Date().toISOString();
    await db.insert(studentIdVerifications).values({
      id: crypto.randomUUID(),
      userId: userA,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10909999',
      imageKey: permKey,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const getRes = await call('/api/v1/auth/verify/student-id', { token: tokenA });
    expect(getRes.status).toBe(200);
    const bodyText = await getRes.text();
    expect(bodyText).not.toContain('imageKey');
    expect(bodyText).not.toContain('secret.jpg');
  });

  it('enforces staff scope for listing, detail, and image stream', async () => {
    const student = await createUser('student-tw@example.com');
    const staffHK = await createUser('staff-hk@example.com', { role: 'staff' });
    const staffTW = await createUser('staff-tw@example.com', { role: 'staff' });
    await createUser('admin@example.com', { role: 'admin' });

    // Assign staff regions
    await env.DB.prepare("INSERT INTO staff_managed_regions (user_id, region_code) VALUES (?, 'HK')").bind(staffHK).run();
    await env.DB.prepare("INSERT INTO staff_managed_regions (user_id, region_code) VALUES (?, 'TW')").bind(staffTW).run();

    const db = createDb(env.DB);
    const now = new Date().toISOString();
    const verifId = crypto.randomUUID();
    const permKey = `student-ids/${student}/id-card.jpg`;
    await env.R2_PRIVATE.put(permKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    await db.insert(studentIdVerifications).values({
      id: verifId,
      userId: student,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10901234',
      imageKey: permKey,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const { access: tokenHK } = await login('staff-hk@example.com');
    const { access: tokenTW } = await login('staff-tw@example.com');
    const { access: tokenAdmin } = await login('admin@example.com');

    // staffHK: listing for TW request is not visible
    const listHK = await call('/api/v1/admin/student-id-verifications', { token: tokenHK });
    expect(listHK.status).toBe(200);
    const listHKJson = (await listHK.json()) as { results: unknown[]; pending_count: number };
    expect(listHKJson.results.length).toBe(0);
    expect(listHKJson.pending_count).toBe(0);

    // staffHK: detail is 403
    const detailHK = await call(`/api/v1/admin/student-id-verifications/${verifId}`, { token: tokenHK });
    expect(detailHK.status).toBe(403);

    // staffHK: image stream is 403
    const imageHK = await call(`/api/v1/admin/student-id-verifications/${verifId}/image`, { token: tokenHK });
    expect(imageHK.status).toBe(403);

    // staffTW: list and detail succeed
    const listTW = await call('/api/v1/admin/student-id-verifications', { token: tokenTW });
    expect(listTW.status).toBe(200);
    const listTWJson = (await listTW.json()) as { results: { id: string }[]; pending_count: number };
    expect(listTWJson.results.length).toBe(1);
    expect(listTWJson.pending_count).toBe(1);

    const detailTW = await call(`/api/v1/admin/student-id-verifications/${verifId}`, { token: tokenTW });
    expect(detailTW.status).toBe(200);
    const detailJson = (await detailTW.json()) as { student_number: string; user: { email: string } };
    expect(detailJson.student_number).toBe('C10901234');
    expect(detailJson.user.email).toBe('student-tw@example.com');

    // staffTW: image stream succeeds with private, no-store
    const imageTW = await call(`/api/v1/admin/student-id-verifications/${verifId}/image`, { token: tokenTW });
    expect(imageTW.status).toBe(200);
    expect(imageTW.headers.get('Cache-Control')).toBe('private, no-store');
    expect(imageTW.headers.get('Content-Type')).toBe('image/jpeg');

    // admin: can access everything
    const detailAdmin = await call(`/api/v1/admin/student-id-verifications/${verifId}`, { token: tokenAdmin });
    expect(detailAdmin.status).toBe(200);
  });

  it('approve creates verification, sets user_school, and deletes image object', async () => {
    const student = await createUser('student-app@example.com', { first: 'Alice', last: 'Wang' });
    const staff = await createUser('staff-app@example.com', { role: 'staff' });
    await env.DB.prepare("INSERT INTO staff_managed_regions (user_id, region_code) VALUES (?, 'TW')").bind(staff).run();

    const db = createDb(env.DB);
    const now = new Date().toISOString();
    const verifId = crypto.randomUUID();
    const permKey = `student-ids/${student}/card.jpg`;
    await env.R2_PRIVATE.put(permKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    await db.insert(studentIdVerifications).values({
      id: verifId,
      userId: student,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10907777',
      imageKey: permKey,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const { access: staffToken } = await login('staff-app@example.com');

    // Approve action
    const approveRes = await call(`/api/v1/admin/student-id-verifications/${verifId}/approve`, {
      method: 'POST',
      token: staffToken,
    });
    expect(approveRes.status).toBe(200);

    // Verify row updated: approved, imageKey is null
    const [updatedReq] = await db.select().from(studentIdVerifications).where(eq(studentIdVerifications.id, verifId));
    expect(updatedReq.status).toBe('approved');
    expect(updatedReq.imageKey).toBeNull();
    expect(updatedReq.reviewedById).toBe(staff);

    // Verify image was deleted from R2_PRIVATE
    expect(await env.R2_PRIVATE.get(permKey)).toBeNull();

    // Verify region_verifications created with method='student_id'
    const [verif] = await db
      .select()
      .from(regionVerifications)
      .where(and(eq(regionVerifications.userId, student), eq(regionVerifications.regionCode, 'TW')));
    expect(verif).toBeDefined();
    expect(verif.method).toBe('student_id');
    expect(verif.studentNumber).toBe('C10907777');
    expect(verif.schoolId).toBe(10);
    expect(verif.isManualVerification).toBe(1);
    expect(verif.isActive).toBe(1);

    // Verify declared school in user_schools
    const [us] = await db
      .select()
      .from(userSchools)
      .where(and(eq(userSchools.userId, student), eq(userSchools.regionCode, 'TW')));
    expect(us).toBeDefined();
    expect(us.schoolId).toBe(10);
  });

  it('reject deletes image and records reject reason', async () => {
    const student = await createUser('student-rej@example.com');
    const staff = await createUser('staff-rej@example.com', { role: 'staff' });
    await env.DB.prepare("INSERT INTO staff_managed_regions (user_id, region_code) VALUES (?, 'TW')").bind(staff).run();

    const db = createDb(env.DB);
    const now = new Date().toISOString();
    const verifId = crypto.randomUUID();
    const permKey = `student-ids/${student}/card.jpg`;
    await env.R2_PRIVATE.put(permKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    await db.insert(studentIdVerifications).values({
      id: verifId,
      userId: student,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10908888',
      imageKey: permKey,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const { access: staffToken } = await login('staff-rej@example.com');

    // Reject without reason is 400
    const failRes = await call(`/api/v1/admin/student-id-verifications/${verifId}/reject`, {
      method: 'POST',
      token: staffToken,
      body: { reason: '' },
    });
    expect(failRes.status).toBe(400);

    // Reject with reason
    const rejRes = await call(`/api/v1/admin/student-id-verifications/${verifId}/reject`, {
      method: 'POST',
      token: staffToken,
      body: { reason: 'Student card photo is too blurry.' },
    });
    expect(rejRes.status).toBe(200);

    // Check DB record
    const [reqRow] = await db.select().from(studentIdVerifications).where(eq(studentIdVerifications.id, verifId));
    expect(reqRow.status).toBe('rejected');
    expect(reqRow.rejectReason).toBe('Student card photo is too blurry.');
    expect(reqRow.imageKey).toBeNull();

    // Check image deleted from R2_PRIVATE
    expect(await env.R2_PRIVATE.get(permKey)).toBeNull();

    // Student GET /verify/student-id sees the rejection reason
    const { access: studentToken } = await login('student-rej@example.com');
    const getRes = await call('/api/v1/auth/verify/student-id', { token: studentToken });
    const getJson = (await getRes.json()) as { request: { status: string; reject_reason: string } };
    expect(getJson.request.status).toBe('rejected');
    expect(getJson.request.reject_reason).toBe('Student card photo is too blurry.');
  });

  it('refuses duplicate student number when already approved for another account', async () => {
    const student1 = await createUser('student1@example.com');
    const student2 = await createUser('student2@example.com');
    const staff = await createUser('staff-dup@example.com', { role: 'staff' });
    await env.DB.prepare("INSERT INTO staff_managed_regions (user_id, region_code) VALUES (?, 'TW')").bind(staff).run();

    const db = createDb(env.DB);
    const now = new Date().toISOString();

    // Student 1 already approved with C10905555 at School 10
    await db.insert(studentIdVerifications).values({
      id: crypto.randomUUID(),
      userId: student1,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10905555',
      imageKey: null,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    });

    // Student 2 has pending request with SAME student number C10905555 at School 10
    const req2Id = crypto.randomUUID();
    await db.insert(studentIdVerifications).values({
      id: req2Id,
      userId: student2,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10905555',
      imageKey: `student-ids/${student2}/card.jpg`,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const { access: staffToken } = await login('staff-dup@example.com');

    // Attempting to approve student 2's request must be refused
    const approveRes = await call(`/api/v1/admin/student-id-verifications/${req2Id}/approve`, {
      method: 'POST',
      token: staffToken,
    });
    expect(approveRes.status).toBe(400);
    const approveJson = (await approveRes.json()) as { error: { code: string } };
    expect(approveJson.error.code).toBe('admin.errStudentNumberAlreadyApproved');
  });

  it('is safe against double-approve races', async () => {
    const student = await createUser('student-race@example.com');
    const staff = await createUser('staff-race@example.com', { role: 'staff' });
    await env.DB.prepare("INSERT INTO staff_managed_regions (user_id, region_code) VALUES (?, 'TW')").bind(staff).run();

    const db = createDb(env.DB);
    const now = new Date().toISOString();
    const verifId = crypto.randomUUID();
    await db.insert(studentIdVerifications).values({
      id: verifId,
      userId: student,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10903333',
      imageKey: null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const { access: staffToken } = await login('staff-race@example.com');

    // First approve
    const res1 = await call(`/api/v1/admin/student-id-verifications/${verifId}/approve`, {
      method: 'POST',
      token: staffToken,
    });
    expect(res1.status).toBe(200);

    // Second approve race
    const res2 = await call(`/api/v1/admin/student-id-verifications/${verifId}/approve`, {
      method: 'POST',
      token: staffToken,
    });
    expect([400, 409]).toContain(res2.status);
  });

  it('cron cleans up requests pending after 30 days and deletes their images', async () => {
    const student = await createUser('student-old@example.com');
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const permKey = `student-ids/${student}/expired.jpg`;
    await env.R2_PRIVATE.put(permKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    const db = createDb(env.DB);
    const verifId = crypto.randomUUID();
    await db.insert(studentIdVerifications).values({
      id: verifId,
      userId: student,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10902222',
      imageKey: permKey,
      status: 'pending',
      createdAt: oldDate,
      updatedAt: oldDate,
    });

    const expiredCount = await purgeExpiredStudentIdVerifications(env);
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    // Image deleted from R2_PRIVATE
    expect(await env.R2_PRIVATE.get(permKey)).toBeNull();

    // Status updated to cancelled with reason
    const [row] = await db.select().from(studentIdVerifications).where(eq(studentIdVerifications.id, verifId));
    expect(row.status).toBe('cancelled');
    expect(row.rejectReason).toBe('acct.studentIdExpired');
    expect(row.imageKey).toBeNull();
  });

  it('cancels pending request and deletes image on account deletion', async () => {
    const student = await createUser('student-del@example.com');
    const permKey = `student-ids/${student}/card.jpg`;
    await env.R2_PRIVATE.put(permKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    const db = createDb(env.DB);
    const now = new Date().toISOString();
    const verifId = crypto.randomUUID();
    await db.insert(studentIdVerifications).values({
      id: verifId,
      userId: student,
      regionCode: 'TW',
      schoolId: 10,
      studentNumber: 'C10901111',
      imageKey: permKey,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    await deleteAccount(env, student);

    // Image deleted from R2_PRIVATE
    expect(await env.R2_PRIVATE.get(permKey)).toBeNull();

    // Row is either cancelled or cascade-deleted with user
    const [row] = await db.select().from(studentIdVerifications).where(eq(studentIdVerifications.id, verifId));
    if (row) {
      expect(row.status).toBe('cancelled');
      expect(row.imageKey).toBeNull();
    }
  });
});
