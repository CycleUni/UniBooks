/**
 * /api/v1/drives, the public side of book drives: registering for their books
 * (登記; docs/plans/2026-11-27-drive-claims/plan.md). Mounted before
 * routes/drives.ts, whose paths are for a drive's admins and staff only.
 *   open?region=&school=&titles=   GET  drives taking registrations (anyone); a school's, previewing titles
 *   claims/mine                    GET  this account's registrations
 *   <id>/public                    GET  a drive's page: titles, copies left, registrations (anyone)
 *   <id>/claim-defaults            GET  the form's student number, department and year
 *   <id>/claims                    POST {book_id, department, grade}
 *   <id>/claims/<claim id>         PATCH {department?, grade?}, DELETE (cancel)
 * The rules are in services/drives/claims.ts.
 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { createDb, type DriveClaim } from '../db';
import { apiError, fieldErrors, readJson } from '../lib/http';
import { assertVerifiedIn, requireRegion } from '../lib/region';
import { nowIso } from '../lib/time';
import { UUID_RE } from '../lib/uuid';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { checkRate } from '../middleware/rateLimit';
import { writeAudit } from '../services/admin/audit';
import { resolveLanguage } from '../services/accounts/i18n';
import { regionCategories, schoolFilterId } from '../services/listings/places';
import { departmentField, gradeField } from '../services/orgs/roster';
import {
  CLAIM_RATE,
  changeClaim,
  claimDefaults,
  claimJson,
  claimsOf,
  createClaim,
  drivePage,
  openDrives,
  ownClaim,
  publicDrive,
} from '../services/drives/claims';

export const driveClaimRoutes = new Hono<AppEnv>();

async function requirePublicDrive(c: Context<AppEnv>) {
  const id = c.req.param('id') ?? '';
  const found = UUID_RE.test(id) ? await publicDrive(c.env, id.toLowerCase()) : null;
  if (!found) apiError(404, 'common.errNotFound');
  return found;
}

/** The department and year a form sent, checked; departments filed under the region's names. */
async function claimFields(c: Context<AppEnv>, regionCode: string, body: Record<string, unknown>, partial: boolean) {
  const errors: Record<string, string[]> = {};
  const out: Partial<Pick<DriveClaim, 'department' | 'grade'>> = {};
  if (!partial || 'department' in body) {
    const d = departmentField(await regionCategories(c.env, regionCode), body.department ?? '');
    if (!d) errors.department = ['org.errDepartment'];
    else out.department = d.value;
  }
  if (!partial || 'grade' in body) {
    const g = gradeField(body.grade ?? '');
    if (g === undefined) errors.grade = ['org.errGrade'];
    else out.grade = g;
  }
  if (Object.keys(errors).length) fieldErrors(errors);
  return out;
}

driveClaimRoutes.get('/open', optionalAuthMiddleware(), async (c) => {
  const region = await requireRegion(c);
  const school = c.req.query('school');
  const schoolId = school ? await schoolFilterId(c.env, region, school) : null;
  // A school nobody recognises resolves to an id no organization has: it lists nothing, not the whole region.
  const results = await openDrives(c.env, region.code, await resolveLanguage(c), nowIso(), {
    schoolId,
    titles: Number(c.req.query('titles') ?? 0) || 0,
    userId: c.get('userId') ?? undefined,
    origin: new URL(c.req.url).origin,
  });
  return c.json({ results });
});

driveClaimRoutes.get('/claims/mine', authMiddleware(), async (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({ results: await claimsOf(c.env, origin, c.get('userId')!, await resolveLanguage(c), nowIso()) });
});

driveClaimRoutes.get('/:id/public', optionalAuthMiddleware(), async (c) => {
  const { drive, org } = await requirePublicDrive(c);
  const origin = new URL(c.req.url).origin;
  return c.json(await drivePage(c.env, origin, drive, org, await resolveLanguage(c), c.get('userId') ?? undefined, nowIso()));
});

driveClaimRoutes.get('/:id/claim-defaults', authMiddleware(), async (c) => {
  const { org } = await requirePublicDrive(c);
  return c.json(await claimDefaults(c.env, org, c.get('userId')!));
});

driveClaimRoutes.post('/:id/claims', authMiddleware(), async (c) => {
  const { drive, org } = await requirePublicDrive(c);
  await assertVerifiedIn(c, drive.regionCode);
  await checkRate(c, 'drive_claim', CLAIM_RATE);
  const body = await readJson(c.req);
  const bookId = typeof body.book_id === 'string' && UUID_RE.test(body.book_id) ? body.book_id.toLowerCase() : null;
  if (!bookId) fieldErrors({ book_id: ['common.errNotFound'] });
  const fields = await claimFields(c, drive.regionCode, body, false);
  const userId = c.get('userId')!;
  const claim = await createClaim(
    c.env,
    drive,
    org,
    userId,
    bookId,
    { department: fields.department ?? '', grade: fields.grade ?? null },
    nowIso(),
  );
  await writeAudit(
    createDb(c.env.DB),
    { actorId: userId, kind: 'drive.claim_registered', meta: { book_id: bookId }, targetType: 'book_drive', targetId: drive.id },
    c,
  );
  return c.json(claimJson(claim), 201);
});

driveClaimRoutes.patch('/:id/claims/:claimId', authMiddleware(), async (c) => {
  const { drive } = await requirePublicDrive(c);
  await checkRate(c, 'drive_claim', CLAIM_RATE);
  const claim = await ownClaim(c.env, drive, c.get('userId')!, c.req.param('claimId'));
  const fields = await claimFields(c, drive.regionCode, await readJson(c.req), true);
  return c.json(claimJson(await changeClaim(c.env, drive, claim, fields, nowIso())));
});

driveClaimRoutes.delete('/:id/claims/:claimId', authMiddleware(), async (c) => {
  const { drive } = await requirePublicDrive(c);
  await checkRate(c, 'drive_claim', CLAIM_RATE);
  const userId = c.get('userId')!;
  const claim = await ownClaim(c.env, drive, userId, c.req.param('claimId'));
  const cancelled = await changeClaim(c.env, drive, claim, { status: 'cancelled' }, nowIso());
  await writeAudit(
    createDb(c.env.DB),
    { actorId: userId, kind: 'drive.claim_cancelled', meta: { book_id: claim.bookId }, targetType: 'book_drive', targetId: drive.id },
    c,
  );
  return c.json(claimJson(cancelled));
});
