/**
 * /api/v1/admin/organizations: site staff create a school's organizations
 * (student unions) and name the accounts that run them. Region-scoped like
 * every admin view: staff see and change only their regions' organizations.
 *   ''                      GET (?region=, ?q=, ?page=), POST {school, name, features?}
 *   <id>                    PATCH {name?, is_active?, features?}
 * `features` is what the organization may use in the event system:
 * {draws?: boolean, drives?: boolean}; a new one gets book drives only.
 *   <id>/admins             POST {email}
 *   <id>/admins/<user id>   DELETE
 */
import { Hono, type Context } from 'hono';
import { and, asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { createDb, organizationAdmins, organizationMembers, organizations, schools, users, type Organization } from '../../db';
import { apiError, fieldErrors, pagination, readJson } from '../../lib/http';
import { isUniqueViolation } from '../../lib/db';
import { changedFields, writeAudit } from '../../services/admin/audit';
import { assertInScope, likeContains, notFound, regionParam, scopeOf, scopeWhere, uuidId } from '../../services/admin/scope';
import { resolveLanguage } from '../../services/accounts/i18n';
import { displayName } from '../../services/accounts/users';
import { organizationJson, schoolsOf } from '../../services/orgs/organizations';

export const organizationRoutes = new Hono<AppEnv>();

const MAX_NAME = 50;

/** The organization `id` if it is in the staff member's regions; else 404. */
async function findOrganization(c: Context<AppEnv>, id: string): Promise<Organization> {
  const [org] = await createDb(c.env.DB)
    .select()
    .from(organizations)
    .where(eq(organizations.id, uuidId(id)))
    .limit(1);
  if (!org) notFound();
  assertInScope(await scopeOf(c), org.regionCode);
  return org;
}

/** Organizations with their admins and member counts, for the list and after each change. */
async function adminView(c: Context<AppEnv>, orgs: Organization[]) {
  if (!orgs.length) return [];
  const db = createDb(c.env.DB);
  const ids = orgs.map((o) => o.id);
  const [schoolMap, lang, admins, counts] = await Promise.all([
    schoolsOf(c.env, orgs),
    resolveLanguage(c),
    db
      .select({ orgId: organizationAdmins.organizationId, id: users.id, email: users.email, first: users.firstName, last: users.lastName })
      .from(organizationAdmins)
      .innerJoin(users, eq(users.id, organizationAdmins.userId))
      .where(inArray(organizationAdmins.organizationId, ids))
      .orderBy(asc(organizationAdmins.createdAt)),
    db
      .select({ orgId: organizationMembers.organizationId, n: count() })
      .from(organizationMembers)
      .where(inArray(organizationMembers.organizationId, ids))
      .groupBy(organizationMembers.organizationId),
  ]);
  const countMap = new Map(counts.map((r) => [r.orgId, r.n]));
  return orgs.map((o) => ({
    ...organizationJson(o, schoolMap.get(o.schoolId), lang),
    admins: admins.filter((a) => a.orgId === o.id).map((a) => ({ id: a.id, email: a.email, display_name: displayName(a.first, a.last) })),
    member_count: countMap.get(o.id) ?? 0,
  }));
}

/** The features in a body, as columns: {draws?, drives?} booleans; absent ones are left as they are. */
function featuresField(body: Record<string, unknown>): Partial<Pick<Organization, 'drawsEnabled' | 'drivesEnabled'>> {
  if (!('features' in body)) return {};
  const f = body.features;
  const bad = (): never => fieldErrors({ features: ['common.errValidation'] });
  if (!f || typeof f !== 'object' || Array.isArray(f)) bad();
  const set: Partial<Pick<Organization, 'drawsEnabled' | 'drivesEnabled'>> = {};
  for (const [key, column] of [
    ['draws', 'drawsEnabled'],
    ['drives', 'drivesEnabled'],
  ] as const) {
    const v = (f as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') bad();
    set[column] = v ? 1 : 0;
  }
  return set;
}

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > MAX_NAME) fieldErrors({ name: ['common.errValidation'] });
  return name;
}

organizationRoutes.get('/organizations', async (c) => {
  const db = createDb(c.env.DB);
  const scope = await scopeOf(c);
  const page = pagination(c.req.url, { allowPageSize: true, maxPageSize: 100 });
  const conds: (SQL | undefined)[] = [scopeWhere(organizations.regionCode, scope)];
  const region = regionParam(c);
  if (region) {
    assertInScope(scope, region);
    conds.push(eq(organizations.regionCode, region));
  }
  const q = (c.req.query('q') ?? '').trim();
  if (q) {
    const contains = likeContains(q);
    conds.push(sql`(${organizations.name} LIKE ${contains} ESCAPE '\\'
      OR ${schools.name} LIKE ${contains} ESCAPE '\\' OR ${schools.translations} LIKE ${contains} ESCAPE '\\'
      OR ${schools.code} = ${q.toUpperCase()})`);
  }
  const where = and(...conds);
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(organizations).innerJoin(schools, eq(schools.id, organizations.schoolId)).where(where),
    db
      .select({ org: organizations })
      .from(organizations)
      .innerJoin(schools, eq(schools.id, organizations.schoolId))
      .where(where)
      .orderBy(asc(organizations.regionCode), asc(schools.code), asc(organizations.name))
      .limit(page.limit)
      .offset(page.offset),
  ]);
  return c.json(
    page.wrap(
      await adminView(
        c,
        rows.map((r) => r.org),
      ),
      total,
    ),
  );
});

organizationRoutes.post('/organizations', async (c) => {
  const db = createDb(c.env.DB);
  const body = await readJson(c.req);
  const schoolId = typeof body.school === 'number' && Number.isSafeInteger(body.school) ? body.school : null;
  const [school] = schoolId === null ? [] : await db.select().from(schools).where(eq(schools.id, schoolId)).limit(1);
  if (!school) fieldErrors({ school: ['common.errValidation'] });
  assertInScope(await scopeOf(c), school.regionCode);
  const name = cleanName(body.name);
  const now = new Date().toISOString();
  const org: Organization = {
    id: crypto.randomUUID(),
    regionCode: school.regionCode,
    schoolId: school.id,
    name,
    isActive: 1,
    drawsEnabled: 0,
    drivesEnabled: 1,
    ...featuresField(body),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(organizations).values(org);
  } catch (e) {
    if (isUniqueViolation(e)) apiError(409, 'admin.errOrganizationExists');
    throw e;
  }
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'admin.organization_created',
      meta: { school_id: school.id, name, draws: org.drawsEnabled, drives: org.drivesEnabled },
      targetType: 'organization',
      targetId: org.id,
    },
    c,
  );
  const [view] = await adminView(c, [org]);
  return c.json(view, 201);
});

organizationRoutes.patch('/organizations/:id', async (c) => {
  const db = createDb(c.env.DB);
  const org = await findOrganization(c, c.req.param('id'));
  const body = await readJson(c.req);
  const set: Partial<Organization> = {};
  if ('name' in body) set.name = cleanName(body.name);
  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') fieldErrors({ is_active: ['common.errValidation'] });
    set.isActive = body.is_active ? 1 : 0;
  }
  Object.assign(set, featuresField(body));
  if (Object.keys(set).length) {
    set.updatedAt = new Date().toISOString();
    try {
      await db.update(organizations).set(set).where(eq(organizations.id, org.id));
    } catch (e) {
      if (isUniqueViolation(e)) apiError(409, 'admin.errOrganizationExists');
      throw e;
    }
    await writeAudit(
      db,
      {
        actorId: c.get('user')!.id,
        kind: 'admin.organization_updated',
        meta: { changes: changedFields(org, set) },
        targetType: 'organization',
        targetId: org.id,
      },
      c,
    );
  }
  const [view] = await adminView(c, [{ ...org, ...set }]);
  return c.json(view);
});

organizationRoutes.post('/organizations/:id/admins', async (c) => {
  const db = createDb(c.env.DB);
  const org = await findOrganization(c, c.req.param('id'));
  const body = await readJson(c.req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) fieldErrors({ email: ['common.errValidation'] });
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || user.deletedAt || !user.isActive || user.isBanned) apiError(404, 'admin.errOrganizationAdminNotFound');
  await db
    .insert(organizationAdmins)
    .values({ organizationId: org.id, userId: user.id, addedById: c.get('user')!.id, createdAt: new Date().toISOString() })
    .onConflictDoNothing();
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'admin.organization_admin_added',
      meta: { user_id: user.id },
      targetType: 'organization',
      targetId: org.id,
    },
    c,
  );
  const [view] = await adminView(c, [org]);
  return c.json(view);
});

organizationRoutes.delete('/organizations/:id/admins/:userId', async (c) => {
  const db = createDb(c.env.DB);
  const org = await findOrganization(c, c.req.param('id'));
  const userId = uuidId(c.req.param('userId'));
  const res = await db
    .delete(organizationAdmins)
    .where(and(eq(organizationAdmins.organizationId, org.id), eq(organizationAdmins.userId, userId)))
    .run();
  if (!res.meta.changes) notFound();
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'admin.organization_admin_removed',
      meta: { user_id: userId },
      targetType: 'organization',
      targetId: org.id,
    },
    c,
  );
  const [view] = await adminView(c, [org]);
  return c.json(view);
});
