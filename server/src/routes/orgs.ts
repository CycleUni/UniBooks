/**
 * /api/v1/orgs: what an organization's admins manage (docs/plans/2026-11-25-book-drive.md).
 *   <id>                         GET     the organization and its member count
 *   <id>/members                 GET     the roster (?q=, ?page=, ?page_size=)
 *   <id>/members/import          POST    {mode: merge|replace, commit, rows}: a preview, or the import
 *   <id>/members/<student no.>   PUT     add or change one member; DELETE removes them
 * Only the organization's own admins get anything; to anyone else every id is a 404.
 * The event system's admin pages call these from the same origin.
 */
import { Hono } from 'hono';
import { and, asc, count, eq, or, sql } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { createDb, organizationMembers } from '../db';
import { apiError, fieldErrors, pagination, readJson } from '../lib/http';
import { authMiddleware } from '../middleware/auth';
import { normalizeStudentNumber } from '../lib/studentNumber';
import { writeAudit } from '../services/admin/audit';
import { likeContains } from '../services/admin/scope';
import { resolveLanguage } from '../services/accounts/i18n';
import { regionCategories } from '../services/listings/places';
import { organizationJson, requireOrgAdmin, schoolsOf } from '../services/orgs/organizations';
import {
  IMPORT_MODES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  importRoster,
  memberJson,
  validateMember,
  writeMembers,
  type ImportMode,
} from '../services/orgs/roster';

export const orgRoutes = new Hono<AppEnv>();

orgRoutes.use('*', authMiddleware());

orgRoutes.get('/:id', async (c) => {
  const org = await requireOrgAdmin(c, c.req.param('id'));
  const db = createDb(c.env.DB);
  const [schoolMap, lang, [{ n }]] = await Promise.all([
    schoolsOf(c.env, [org]),
    resolveLanguage(c),
    db.select({ n: count() }).from(organizationMembers).where(eq(organizationMembers.organizationId, org.id)),
  ]);
  return c.json({ ...organizationJson(org, schoolMap.get(org.schoolId), lang), member_count: n });
});

orgRoutes.get('/:id/members', async (c) => {
  const org = await requireOrgAdmin(c, c.req.param('id'));
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url, { pageSize: 50, allowPageSize: true, maxPageSize: 200 });
  const conds = [eq(organizationMembers.organizationId, org.id)];
  const q = (c.req.query('q') ?? '').trim();
  if (q) {
    const contains = likeContains(q);
    conds.push(
      or(
        sql`${organizationMembers.studentNumber} LIKE ${likeContains(q.toUpperCase()).slice(1)} ESCAPE '\\'`,
        sql`${organizationMembers.name} LIKE ${contains} ESCAPE '\\'`,
        sql`${organizationMembers.department} LIKE ${contains} ESCAPE '\\'`,
      )!,
    );
  }
  const where = and(...conds);
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(organizationMembers).where(where),
    db
      .select()
      .from(organizationMembers)
      .where(where)
      .orderBy(asc(organizationMembers.studentNumber))
      .limit(page.limit)
      .offset(page.offset),
  ]);
  return c.json(page.wrap(rows.map(memberJson), total));
});

orgRoutes.post('/:id/members/import', async (c) => {
  const org = await requireOrgAdmin(c, c.req.param('id'));
  const body = await readJson(c.req, MAX_IMPORT_BYTES);
  const mode = IMPORT_MODES.find((m) => m === body.mode) as ImportMode | undefined;
  if (!mode) fieldErrors({ mode: ['common.errValidation'] });
  if (!Array.isArray(body.rows) || body.rows.length === 0) apiError(400, 'org.errImportEmpty');
  if (body.rows.length > MAX_IMPORT_ROWS) apiError(400, 'org.errImportTooMany', { max: MAX_IMPORT_ROWS });
  const commit = body.commit === true;

  const db = createDb(c.env.DB);
  const existing = await db.select().from(organizationMembers).where(eq(organizationMembers.organizationId, org.id));
  const result = await importRoster(c.env, org, body.rows, mode, commit, existing);
  if (commit && !result.committed) apiError(400, 'org.errImportHasErrors', { ...result });
  if (result.committed) {
    await writeAudit(
      db,
      {
        actorId: c.get('user')!.id,
        kind: 'org.members_imported',
        meta: { mode, ...result.summary },
        targetType: 'organization',
        targetId: org.id,
      },
      c,
    );
  }
  return c.json(result);
});

orgRoutes.put('/:id/members/:number', async (c) => {
  const org = await requireOrgAdmin(c, c.req.param('id'));
  const number = normalizeStudentNumber(c.req.param('number'));
  if (!number) apiError(404, 'common.errNotFound');
  const body = await readJson(c.req);
  const check = validateMember({ ...body, student_number: number }, await regionCategories(c.env, org.regionCode));
  if (!check.member) {
    fieldErrors(Object.fromEntries(check.errors.map((e) => [fieldOf(e), [e]])));
  }
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();
  await c.env.DB.batch(writeMembers(c.env, org.id, [check.member], now));
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'org.member_saved',
      meta: { student_number: number },
      targetType: 'organization',
      targetId: org.id,
    },
    c,
  );
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, org.id), eq(organizationMembers.studentNumber, number)));
  return c.json({ ...memberJson(row), warnings: check.warnings });
});

orgRoutes.delete('/:id/members/:number', async (c) => {
  const org = await requireOrgAdmin(c, c.req.param('id'));
  const number = normalizeStudentNumber(c.req.param('number'));
  if (!number) apiError(404, 'common.errNotFound');
  const db = createDb(c.env.DB);
  const res = await db
    .delete(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, org.id), eq(organizationMembers.studentNumber, number)))
    .run();
  if (!res.meta.changes) apiError(404, 'common.errNotFound');
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'org.member_deleted',
      meta: { student_number: number },
      targetType: 'organization',
      targetId: org.id,
    },
    c,
  );
  return c.body(null, 204);
});

/** The request field a roster error code is about. */
function fieldOf(code: string): string {
  return (
    {
      'org.errStudentNumber': 'student_number',
      'org.errName': 'name',
      'org.errDepartment': 'department',
      'org.errGrade': 'grade',
      'org.errValidUntil': 'valid_until',
    }[code] ?? 'non_field_errors'
  );
}
