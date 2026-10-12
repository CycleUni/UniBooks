import { Hono } from 'hono';
import { inList } from '../../lib/sql';
import type { Context } from 'hono';
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { createDb, regionVerifications, regions, schools, staffManagedRegions, users, type Database, type User } from '../../db';
import { apiError, pagination, readJson } from '../../lib/http';
import { getRegion } from '../../lib/region';
import { requireSuperuser } from '../../middleware/auth';
import { displayName } from '../../services/accounts/users';
import { writeAudit } from '../../services/admin/audit';
import { localized, resolveLanguage } from '../../services/admin/i18n';
import { adminSchoolFilterId } from '../../services/admin/schoolCodes';
import { likeContains, notFound, regionParam, scopeOf, uuidId } from '../../services/admin/scope';
import { schoolSearch } from './schools';

/**
 * Granting staff rights is superuser-only (managers/<id>/toggle/); the user
 * PATCH never accepts is_staff / is_superuser / password.
 */
export const userRoutes = new Hono<AppEnv>();

const FORBIDDEN_USER_FIELDS = ['is_staff', 'is_superuser', 'password', 'groups', 'user_permissions', 'role'];

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface VerificationRow {
  userId: string;
  regionCode: string;
  schoolId: number | null;
  eduEmail: string | null;
  verifiedAt: string;
  schoolCode: string | null;
  schoolName: string | null;
  schoolTranslations: string | null;
}

async function activeVerifications(db: Database, userIds: string[]): Promise<Map<string, VerificationRow[]>> {
  const out = new Map<string, VerificationRow[]>();
  if (!userIds.length) return out;
  const rows: VerificationRow[] = [];
  // D1 binds at most 100 parameters per statement.
  for (let i = 0; i < userIds.length; i += 90) {
    rows.push(
      ...(await db
        .select({
          userId: regionVerifications.userId,
          regionCode: regionVerifications.regionCode,
          schoolId: regionVerifications.schoolId,
          eduEmail: regionVerifications.eduEmail,
          verifiedAt: regionVerifications.verifiedAt,
          schoolCode: schools.code,
          schoolName: schools.name,
          schoolTranslations: schools.translations,
        })
        .from(regionVerifications)
        .leftJoin(schools, eq(schools.id, regionVerifications.schoolId))
        .where(and(inArray(regionVerifications.userId, userIds.slice(i, i + 90)), eq(regionVerifications.isActive, 1)))),
    );
  }
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push(r);
    out.set(r.userId, list);
  }
  // Ordered by region code: the flat fields take the first row.
  for (const list of out.values()) list.sort((a, b) => (a.regionCode < b.regionCode ? -1 : a.regionCode > b.regionCode ? 1 : 0));
  return out;
}

function schoolLabel(v: VerificationRow, lang: string | null): string {
  if (v.schoolId === null || v.schoolName === null) return '';
  return lang ? localized(v.schoolTranslations, lang, 'name', v.schoolName) : v.schoolName;
}

export function userJson(u: User, verifications: VerificationRow[], lang: string | null) {
  const primary = verifications[0];
  return {
    id: u.id,
    email: u.email,
    first_name: u.firstName,
    last_name: u.lastName,
    display_name: displayName(u.firstName, u.lastName),
    school: primary ? primary.schoolId : null,
    school_name: primary ? schoolLabel(primary, lang) : '',
    edu_email: primary ? primary.eduEmail : null,
    is_active: !!u.isActive,
    is_verified: verifications.length > 0,
    verified_at: primary ? primary.verifiedAt : null,
    created_at: u.createdAt,
    is_staff: u.role === 'staff' || u.role === 'admin',
    is_superuser: u.role === 'admin',
    regions: verifications.map((v) => v.regionCode),
    verifications: verifications.map((v) => ({
      region: v.regionCode,
      school: v.schoolId,
      school_code: v.schoolCode ?? '',
      school_name: schoolLabel(v, lang),
      edu_email: v.eduEmail,
      verified_at: v.verifiedAt,
    })),
  };
}

async function serializeOne(c: Context<AppEnv>, db: Database, u: User) {
  const vs = await activeVerifications(db, [u.id]);
  return userJson(u, vs.get(u.id) ?? [], await resolveLanguage(c));
}

/** Users a region manager may see: verified (any state) in a managed region, or never verified anywhere. */
function userScope(scope: string[] | null): SQL | undefined {
  if (scope === null) return undefined;
  const noVerification = sql`NOT EXISTS (SELECT 1 FROM ${regionVerifications} rv WHERE rv.user_id = ${users.id})`;
  if (!scope.length) return noVerification;
  return sql`(${noVerification} OR EXISTS (SELECT 1 FROM ${regionVerifications} rv WHERE rv.user_id = ${users.id} AND rv.region_code IN (${sql.join(
    scope.map((s) => sql`${s}`),
    sql`, `,
  )})))`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

userRoutes.get('/users/', async (c) => {
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url);
  const conds: (SQL | undefined)[] = [userScope(await scopeOf(c))];

  const q = c.req.query('q');
  if (q) {
    const like = likeContains(q);
    conds.push(sql`(
      ${users.email} LIKE ${like} ESCAPE '\\'
      OR ${users.firstName} LIKE ${like} ESCAPE '\\'
      OR ${users.lastName} LIKE ${like} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM ${regionVerifications} rv WHERE rv.user_id = ${users.id} AND rv.edu_email LIKE ${like} ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM ${regionVerifications} rv JOIN ${schools} ON ${schools.id} = rv.school_id
                 WHERE rv.user_id = ${users.id} AND ${schoolSearch(q)})
    )`);
  }
  const isActive = c.req.query('is_active');
  if (isActive !== undefined) conds.push(eq(users.isActive, isActive.toLowerCase() === 'true' ? 1 : 0));
  const school = c.req.query('school');
  if (school) {
    const schoolId = await adminSchoolFilterId(db, (await getRegion(c))?.code ?? null, school);
    conds.push(sql`EXISTS (SELECT 1 FROM ${regionVerifications} rv WHERE rv.user_id = ${users.id} AND rv.school_id = ${schoolId ?? 0})`);
  }
  const region = regionParam(c);
  if (region) {
    conds.push(sql`(
      EXISTS (SELECT 1 FROM ${regionVerifications} rv WHERE rv.user_id = ${users.id} AND rv.region_code = ${region})
      OR NOT EXISTS (SELECT 1 FROM ${regionVerifications} rv WHERE rv.user_id = ${users.id})
    )`);
  }
  const where = and(...conds);
  const [{ n }] = await db.select({ n: count() }).from(users).where(where);
  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(page.limit)
    .offset(page.offset);
  const vs = await activeVerifications(
    db,
    rows.map((u) => u.id),
  );
  const lang = await resolveLanguage(c);
  return c.json(
    page.wrap(
      rows.map((u) => userJson(u, vs.get(u.id) ?? [], lang)),
      n,
    ),
  );
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

async function loadUser(c: Context<AppEnv>, db: Database): Promise<User> {
  const id = uuidId(c.req.param('id'));
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), userScope(await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

userRoutes.get('/users/:id/', async (c) => {
  const db = createDb(c.env.DB);
  return c.json(await serializeOne(c, db, await loadUser(c, db)));
});

/** The verification row for (user, region), created as a manual one when missing. */
async function ensureVerification(db: Database, userId: string, regionCode: string, nowIso: string) {
  const [region] = await db.select({ code: regions.code }).from(regions).where(eq(regions.code, regionCode)).limit(1);
  if (!region) apiError(400, 'admin.errDatabaseIntegrity');
  const [existing] = await db
    .select()
    .from(regionVerifications)
    .where(and(eq(regionVerifications.userId, userId), eq(regionVerifications.regionCode, regionCode)))
    .limit(1);
  if (existing) return { row: existing, created: false };
  // An active row IS a verification, so a row created only to carry a
  // school starts inactive; `verified: true` activates it.
  const [row] = await db
    .insert(regionVerifications)
    .values({
      userId,
      regionCode,
      eduEmail: null,
      isManualVerification: 1,
      verifiedAt: nowIso,
      isActive: 0,
      createdAt: nowIso,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { row, created: true };
  const [raced] = await db
    .select()
    .from(regionVerifications)
    .where(and(eq(regionVerifications.userId, userId), eq(regionVerifications.regionCode, regionCode)))
    .limit(1);
  if (!raced) apiError(400, 'admin.errDatabaseIntegrity');
  return { row: raced, created: false };
}

userRoutes.patch('/users/:id/', async (c) => {
  const data = await readJson(c.req);
  if (FORBIDDEN_USER_FIELDS.some((f) => f in data)) apiError(400, 'admin.errForbiddenField');
  const db = createDb(c.env.DB);
  const instance = await loadUser(c, db);
  const me = c.get('user')!;
  const scope = await scopeOf(c);
  const changes: Record<string, unknown> = {};
  const now = new Date().toISOString();

  if (data.is_active === false && instance.id === me.id) apiError(400, 'admin.errSelfDisable');

  let newIsActive: number | undefined;
  if ('is_active' in data) {
    const value = data.is_active;
    if (typeof value !== 'boolean') apiError(400, 'admin.errInvalidField');
    if (!value && (instance.role === 'staff' || instance.role === 'admin')) apiError(400, 'admin.errForbiddenField');
    if (!!instance.isActive !== value) {
      newIsActive = value ? 1 : 0;
      changes.is_active = value;
    }
  }

  const regionFor = (): string => {
    const code = typeof data.region === 'string' ? data.region.trim().toUpperCase() : '';
    if (!code) apiError(400, 'admin.errMissingRegion');
    if (scope !== null && !scope.includes(code)) apiError(403, 'admin.errRegionForbidden');
    return code;
  };

  let schoolUpdate: { regionCode: string; schoolId: number | null } | undefined;
  if ('school' in data) {
    const raw = data.school;
    let newSchoolId: number | null = null;
    if (raw !== null) {
      const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(id)) apiError(400, 'admin.errInvalidField');
      const [s] = await db.select({ id: schools.id }).from(schools).where(eq(schools.id, id)).limit(1);
      if (!s) apiError(400, 'admin.errInvalidField');
      newSchoolId = s.id;
    }
    schoolUpdate = { regionCode: regionFor(), schoolId: newSchoolId };
  }

  let verifiedUpdate: { regionCode: string; value: boolean } | undefined;
  if ('verified' in data) {
    if (typeof data.verified !== 'boolean') apiError(400, 'admin.errInvalidField');
    verifiedUpdate = { regionCode: regionFor(), value: data.verified };
  }

  if (newIsActive !== undefined) {
    await db.update(users).set({ isActive: newIsActive, updatedAt: now }).where(eq(users.id, instance.id));
  }
  if (schoolUpdate) {
    const { row } = await ensureVerification(db, instance.id, schoolUpdate.regionCode, now);
    if (row.schoolId !== schoolUpdate.schoolId) {
      await db.update(regionVerifications).set({ schoolId: schoolUpdate.schoolId }).where(eq(regionVerifications.id, row.id));
      changes.school = schoolUpdate.schoolId;
    }
  }
  if (verifiedUpdate) {
    const { row } = await ensureVerification(db, instance.id, verifiedUpdate.regionCode, now);
    if (verifiedUpdate.value && !row.isActive) {
      await db.update(regionVerifications).set({ isActive: 1, verifiedAt: now, expiresAt: null }).where(eq(regionVerifications.id, row.id));
      changes.verified_at = now;
    } else if (!verifiedUpdate.value && row.isActive) {
      await db.update(regionVerifications).set({ isActive: 0 }).where(eq(regionVerifications.id, row.id));
      changes.verified_at = null;
    }
  }

  await writeAudit(
    db,
    {
      actorId: me.id,
      kind: 'admin.user_updated',
      meta: { target_user_id: instance.id, changes },
      targetType: 'user',
      targetId: instance.id,
    },
    c,
  );
  const [fresh] = await db.select().from(users).where(eq(users.id, instance.id)).limit(1);
  return c.json(await serializeOne(c, db, fresh));
});

// ---------------------------------------------------------------------------
// Managers (superuser only)
// ---------------------------------------------------------------------------

userRoutes.post('/managers/:id/toggle/', requireSuperuser(), async (c) => {
  const db = createDb(c.env.DB);
  const id = uuidId(c.req.param('id'));
  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) notFound();
  const data = await readJson(c.req);
  const me = c.get('user')!;
  const metaChanges: Record<string, unknown> = {};
  let hasChanges = false;

  let newRole: User['role'] | undefined;
  if ('is_staff' in data) {
    const v = data.is_staff;
    if (typeof v !== 'boolean') apiError(400, 'admin.errInvalidField');
    const isStaff = target.role === 'staff' || target.role === 'admin';
    if (isStaff !== v) {
      // A superuser is staff by definition here (role 'admin'); demoting one
      // is not something this endpoint can express.
      if (target.role === 'admin') apiError(400, 'admin.errForbiddenField');
      newRole = v ? 'staff' : 'user';
    }
  }
  let newRegions: string[] | undefined;
  if ('managed_regions' in data) {
    const v = data.managed_regions;
    if (!Array.isArray(v)) apiError(400, 'admin.errInvalidField');
    const codes = v.filter((x): x is string => typeof x === 'string');
    newRegions = codes.length
      ? (await db.select({ code: regions.code }).from(regions).where(inList(regions.code, codes))).map((r) => r.code)
      : [];
  }

  const writes: Parameters<Database['batch']>[0][number][] = [];
  if (newRole) {
    writes.push(db.update(users).set({ role: newRole, updatedAt: new Date().toISOString() }).where(eq(users.id, target.id)));
    hasChanges = true;
    metaChanges.is_staff = newRole === 'staff';
  }
  if (newRegions) {
    writes.push(db.delete(staffManagedRegions).where(eq(staffManagedRegions.userId, target.id)));
    if (newRegions.length) {
      writes.push(db.insert(staffManagedRegions).values(newRegions.map((code) => ({ userId: target.id, regionCode: code }))));
    }
    hasChanges = true;
    metaChanges.managed_regions = data.managed_regions;
  }
  if (writes.length) await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
  if (hasChanges) {
    await writeAudit(
      db,
      {
        actorId: me.id,
        kind: 'admin.manager_toggled',
        meta: { target_user_id: target.id, changes: metaChanges },
        targetType: 'user',
        targetId: target.id,
      },
      c,
    );
  }
  const [fresh] = await db.select().from(users).where(eq(users.id, target.id)).limit(1);
  // Serialized without a request context: names unlocalized.
  const vs = await activeVerifications(db, [fresh.id]);
  return c.json(userJson(fresh, vs.get(fresh.id) ?? [], null));
});
