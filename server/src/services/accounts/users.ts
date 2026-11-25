import type { Context } from 'hono';
import { and, asc, eq, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { AppEnv, Env } from '../../env';
import {
  createDb,
  listings,
  oneTimeTokens,
  passkeys,
  pushDevices,
  refreshTokens,
  regionVerifications,
  reviews,
  schoolRequests,
  staffManagedRegions,
  studentIdVerifications,
  subscriptions,
  userSchools,
  users,
  type User,
  organizationAdmins,
} from '../../db';
import { activeRegions, getRegion, liveVerification } from '../../lib/region';
import { resolveLanguage } from './i18n';
import { localizedName, type Row } from './regionData';
import { organizationsAdministeredBy } from '../orgs/organizations';
import { cancelEmailChangeStatement } from './oneTimeTokens';
import { revokeAllTokensForUser } from './tokens';
import { newHexId } from '../../lib/uuid';
import { nowIso } from '../../lib/time';
import { cancelOpenOrdersForUser } from '../orders/cancel';
import { disconnectUser } from '../messaging/disconnect';
import { markAllDeletedFor } from '../messaging/conversations';
import { deleteListingPhotos } from '../listings/photos';
import { parsePhotos } from '../../lib/json';
import { siteOrigin } from '../../lib/origin';

/** "First Last" when either part is Latin, else "LastFirst". */
export function displayName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const last = lastName || '';
  const first = firstName || '';
  if (last && first) {
    if (/[A-Za-z]/.test(last) || /[A-Za-z]/.test(first)) return `${first} ${last}`;
    return `${last}${first}`;
  }
  return `${last}${first}`.trim();
}

/** The avatar as other users may see it: '' when the owner hid it. */
export function publicAvatarUrl(user: { avatarUrl?: string | null; showAvatar?: number | boolean | null }): string {
  return user.showAvatar ? user.avatarUrl || '' : '';
}

export const isStaffRole = (role: string) => role === 'staff' || role === 'admin';

/** Switched off, banned or deleted: no sign-in of any kind gets past this. */
export function accountDisabled(user: { isActive: number; isBanned: number; deletedAt: string | null }): boolean {
  return !user.isActive || !!user.isBanned || !!user.deletedAt;
}

export async function touchLastLogin(env: Env, userId: string): Promise<void> {
  await createDb(env.DB).update(users).set({ lastLoginAt: nowIso() }).where(eq(users.id, userId)).run();
}

export async function getUser(env: Env, id: string): Promise<User | null> {
  const [row] = await createDb(env.DB).select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function getUserByEmail(env: Env, email: string): Promise<User | null> {
  const [row] = await createDb(env.DB)
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email.trim()})`)
    .limit(1);
  return row ?? null;
}

interface VerificationRow {
  region_code: string;
  school_id: number | null;
  edu_email: string | null;
  method: string | null;
  student_number: string | null;
  verified_at: string;
  expires_at: string | null;
}

/** The user's live verifications (active, verified, unexpired), sorted by region, with their schools. */
export async function verificationsOf(env: Env, userId: string): Promise<(VerificationRow & { school: Row | null })[]> {
  const results: VerificationRow[] = await createDb(env.DB)
    .select({
      region_code: regionVerifications.regionCode,
      school_id: regionVerifications.schoolId,
      edu_email: regionVerifications.eduEmail,
      method: regionVerifications.method,
      student_number: regionVerifications.studentNumber,
      verified_at: regionVerifications.verifiedAt,
      expires_at: regionVerifications.expiresAt,
    })
    .from(regionVerifications)
    .where(and(eq(regionVerifications.userId, userId), isNotNull(regionVerifications.verifiedAt), liveVerification()))
    .orderBy(asc(regionVerifications.regionCode));
  const ids = [...new Set(results.map((r) => r.school_id).filter((id): id is number => id !== null))];
  const schools = new Map<number, Row>();
  if (ids.length) {
    // Raw: schools are read as `SELECT *` rows (see regionData.ts).
    const { results: rows } = await env.DB.prepare(`SELECT * FROM schools WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids))
      .all<Row>();
    for (const s of rows) schools.set(Number(s.id), s);
  }
  return results.map((r) => ({ ...r, school: r.school_id !== null ? (schools.get(r.school_id) ?? null) : null }));
}

export interface DeclaredSchoolRow {
  region_code: string;
  school_id: number;
  school: Row | null;
}

/** The user's declared school per region, with their school rows. */
export async function declaredSchoolsOf(env: Env, userId: string): Promise<DeclaredSchoolRow[]> {
  const results = await createDb(env.DB)
    .select({
      region_code: userSchools.regionCode,
      school_id: userSchools.schoolId,
    })
    .from(userSchools)
    .where(eq(userSchools.userId, userId))
    .orderBy(asc(userSchools.regionCode));
  const ids = [...new Set(results.map((r) => r.school_id))];
  const schoolsMap = new Map<number, Row>();
  if (ids.length) {
    const { results: rows } = await env.DB.prepare(`SELECT * FROM schools WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids))
      .all<Row>();
    for (const s of rows) schoolsMap.set(Number(s.id), s);
  }
  return results.map((r) => ({ ...r, school: schoolsMap.get(r.school_id) ?? null }));
}

/**
 * The user's verifications that are still bound but past their expiry: the
 * student has to prove the address again (link, one-click, or a Google
 * sign-in with it) to get them back.
 */
async function lapsedVerificationsOf(env: Env, userId: string) {
  return createDb(env.DB)
    .select({
      region_code: regionVerifications.regionCode,
      edu_email: regionVerifications.eduEmail,
      expires_at: regionVerifications.expiresAt,
    })
    .from(regionVerifications)
    .where(
      and(
        eq(regionVerifications.userId, userId),
        eq(regionVerifications.isActive, 1),
        isNotNull(regionVerifications.expiresAt),
        lte(regionVerifications.expiresAt, new Date().toISOString()),
      ),
    )
    .orderBy(asc(regionVerifications.regionCode));
}

/** Average rating, review count and no-show count. */
export async function reputationOf(env: Env, userId: string) {
  const rated = sql`${reviews.isNoShow} = 0 AND ${reviews.rating} IS NOT NULL`;
  const [row] = await createDb(env.DB)
    .select({
      avg: sql<number | null>`AVG(CASE WHEN ${rated} THEN ${reviews.rating} END)`,
      reviews: sql<number | null>`SUM(CASE WHEN ${rated} THEN 1 ELSE 0 END)`,
      no_shows: sql<number | null>`SUM(CASE WHEN ${reviews.isNoShow} = 1 THEN 1 ELSE 0 END)`,
    })
    .from(reviews)
    .where(eq(reviews.revieweeId, userId))
    .catch(() => []);
  return {
    average_rating: row?.avg != null ? Math.round(row.avg * 10) / 10 : 0.0,
    review_count: Number(row?.reviews ?? 0),
    no_show_count: Number(row?.no_shows ?? 0),
  };
}

/** The regions a staff member manages. */
export async function managedRegionsOf(env: Env, userId: string): Promise<string[]> {
  const results = await createDb(env.DB)
    .select({ regionCode: staffManagedRegions.regionCode })
    .from(staffManagedRegions)
    .where(eq(staffManagedRegions.userId, userId));
  return results.map((r) => String(r.regionCode).toUpperCase()).sort();
}

/** The signed-in user's own view of their account. */
export async function serializeUser(c: Context<AppEnv>, user: User): Promise<Record<string, unknown>> {
  const isStaff = isStaffRole(user.role);
  const langP = resolveLanguage(c);
  const [region, lang, verifications, declared, lapsed, reputation, managedRegions, active, organizations] = await Promise.all([
    getRegion(c),
    langP,
    verificationsOf(c.env, user.id),
    declaredSchoolsOf(c.env, user.id),
    lapsedVerificationsOf(c.env, user.id),
    reputationOf(c.env, user.id),
    isStaff ? managedRegionsOf(c.env, user.id) : Promise.resolve([]),
    activeRegions(c.env),
    langP.then((l) => organizationsAdministeredBy(c.env, user.id, l)),
  ]);
  const regions = verifications.map((v) => v.region_code.toUpperCase());

  // Current region status
  const currentVerif = region
    ? (verifications.find((v) => v.region_code.toUpperCase() === region.code.toUpperCase()) ?? null)
    : (verifications[0] ?? null);
  const currentDecl = region
    ? (declared.find((d) => d.region_code.toUpperCase() === region.code.toUpperCase()) ?? null)
    : (declared[0] ?? null);
  const currentResolved = currentVerif?.school ?? currentDecl?.school ?? null;
  const currentIsVerified = !!currentVerif;
  const currentMustVerify = !!currentResolved && currentResolved.requires_verification === 1 && !currentIsVerified;

  // Build per_region
  const perRegion: Record<
    string,
    {
      declared_school: { id: number; code: string; name: string; requires_verification: boolean } | null;
      verified_school: { id: number; code: string; name: string } | null;
      is_verified: boolean;
      must_verify: boolean;
    }
  > = {};

  const allRegionCodes = new Set([
    ...Array.from(active.keys()),
    ...verifications.map((v) => v.region_code.toUpperCase()),
    ...declared.map((d) => d.region_code.toUpperCase()),
  ]);

  for (const regCode of allRegionCodes) {
    const v = verifications.find((v) => v.region_code.toUpperCase() === regCode) ?? null;
    const d = declared.find((d) => d.region_code.toUpperCase() === regCode) ?? null;
    const isV = !!v;
    const res = v?.school ?? d?.school ?? null;
    const mustV = !!res && res.requires_verification === 1 && !isV;
    perRegion[regCode] = {
      declared_school: d?.school
        ? {
            id: Number(d.school.id),
            code: String(d.school.code ?? ''),
            name: localizedName(d.school, lang),
            requires_verification: d.school.requires_verification === 1,
          }
        : null,
      verified_school: v?.school
        ? {
            id: Number(v.school.id),
            code: String(v.school.code ?? ''),
            name: localizedName(v.school, lang),
          }
        : null,
      is_verified: isV,
      must_verify: mustV,
    };
  }

  return {
    id: user.id,
    email: user.email,
    edu_email: currentVerif ? currentVerif.edu_email : null,
    first_name: user.firstName,
    last_name: user.lastName,
    display_name: displayName(user.firstName, user.lastName),
    school: currentResolved ? Number(currentResolved.id) : null,
    school_code: currentResolved ? String(currentResolved.code ?? '') : '',
    school_name: currentResolved ? localizedName(currentResolved, lang) : '',
    is_active: !!user.isActive,
    is_verified: currentIsVerified,
    must_verify: currentMustVerify,
    school_prompted: !!user.schoolPromptedAt,
    school_prompted_at: user.schoolPromptedAt ?? null,
    declared_school: currentDecl?.school
      ? {
          id: Number(currentDecl.school.id),
          code: String(currentDecl.school.code ?? ''),
          name: localizedName(currentDecl.school, lang),
          requires_verification: currentDecl.school.requires_verification === 1,
        }
      : null,
    verified_school: currentVerif?.school
      ? {
          id: Number(currentVerif.school.id),
          code: String(currentVerif.school.code ?? ''),
          name: localizedName(currentVerif.school, lang),
        }
      : null,
    per_region: perRegion,
    user_schools: declared.map((d) => ({
      region: d.region_code.toUpperCase(),
      school: d.school_id,
      school_code: d.school ? String(d.school.code ?? '') : '',
      school_name: d.school ? localizedName(d.school, lang) : '',
    })),
    verified_at: currentVerif ? currentVerif.verified_at : null,
    ...reputation,
    has_password: !!user.passwordHash,
    is_google_linked: !!user.googleId,
    passkey_2fa: !!user.passkey2fa,
    avatar_url: user.avatarUrl || null,
    show_avatar: !!user.showAvatar,
    last_seen_bought_orders_at: user.lastSeenBoughtOrdersAt ?? null,
    last_seen_sold_orders_at: user.lastSeenSoldOrdersAt ?? null,
    role: user.role,
    managed_regions: managedRegions,
    // The organizations this account runs (book drives, rosters).
    organizations,
    regions,
    verifications: verifications.map((v) => ({
      region: v.region_code.toUpperCase(),
      school: v.school_id,
      school_code: v.school ? String(v.school.code ?? '') : '',
      school_name: v.school ? localizedName(v.school, lang) : '',
      edu_email: v.edu_email,
      method: v.method,
      student_number: v.student_number,
      verified_at: v.verified_at,
      expires_at: v.expires_at,
    })),
    lapsed_verifications: lapsed.map((v) => ({ region: v.region_code.toUpperCase(), edu_email: v.edu_email, expires_at: v.expires_at })),
    site_language: user.siteLanguage,
    site_region: active.has(user.siteRegion.toUpperCase()) ? user.siteRegion.toUpperCase() : '',
  };
}

/** The public view of a user's profile. */
export async function serializePublicUser(c: Context<AppEnv>, user: User): Promise<Record<string, unknown>> {
  const [region, lang, verifications, declared, reputation] = await Promise.all([
    getRegion(c),
    resolveLanguage(c),
    verificationsOf(c.env, user.id),
    declaredSchoolsOf(c.env, user.id),
    reputationOf(c.env, user.id),
  ]);
  const currentVerif = region
    ? (verifications.find((v) => v.region_code.toUpperCase() === region.code.toUpperCase()) ?? null)
    : (verifications[0] ?? null);
  const currentDecl = region
    ? (declared.find((d) => d.region_code.toUpperCase() === region.code.toUpperCase()) ?? null)
    : (declared[0] ?? null);
  const currentResolved = currentVerif?.school ?? currentDecl?.school ?? null;

  return {
    id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    display_name: displayName(user.firstName, user.lastName),
    school_name: currentResolved ? localizedName(currentResolved, lang) : '',
    created_at: user.createdAt,
    is_verified: !!currentVerif,
    ...reputation,
    avatar_url: publicAvatarUrl(user),
  };
}

/** The columns a first/last name change touches, `name` included. */
export function nameColumns(firstName: string, lastName: string) {
  return { firstName, lastName, name: displayName(firstName, lastName) };
}

/**
 * "Deleting" an account empties it rather than removing the row when other people's history points at it (orders, reviews,
 * chats, reports): a real delete would take that with it. An account with none of that is removed outright, leaving no
 * anonymized row behind.
 */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  const db = createDb(env.DB);
  // Switched off before anything else: from here no request of this account
  // passes authentication, so no order or listing appears while the rest runs.
  await db.update(users).set({ isActive: 0, updatedAt: nowIso() }).where(eq(users.id, userId)).run();
  // Then, through each order's lock: the other party is told and any
  // reservation released, rather than an open order left on a gone listing.
  await cancelOpenOrdersForUser(env, userId);
  // Their side of every conversation counts as deleted; one the other side
  // had already deleted goes now, messages and images included. The rest
  // stay with the other side until they delete it too.
  await markAllDeletedFor(env, userId);
  const now = new Date().toISOString();
  const hex = newHexId();
  const own = await db.select({ photos: listings.photos }).from(listings).where(eq(listings.sellerId, userId));

  // Cancel any pending student ID verification and delete its private image
  const pendingStudentVerifs = await db
    .select({ id: studentIdVerifications.id, imageKey: studentIdVerifications.imageKey })
    .from(studentIdVerifications)
    .where(and(eq(studentIdVerifications.userId, userId), eq(studentIdVerifications.status, 'pending')));
  for (const pv of pendingStudentVerifs) {
    if (pv.imageKey) {
      await env.R2_PRIVATE.delete(pv.imageKey).catch((e) =>
        console.error(`[deleteAccount] failed to delete private image ${pv.imageKey}`, e),
      );
    }
  }
  await db
    .update(studentIdVerifications)
    .set({ status: 'cancelled', imageKey: null, updatedAt: now })
    .where(and(eq(studentIdVerifications.userId, userId), eq(studentIdVerifications.status, 'pending')));
  // A kept, anonymized account no longer runs any organization.
  await db.delete(organizationAdmins).where(eq(organizationAdmins.userId, userId));

  // Reviews hang off orders, and messages off conversations, so these four cover every record kept for the other party.
  const retained = await env.DB.prepare(
    `SELECT 1 AS hit FROM orders WHERE buyer_id = ?1 OR seller_id = ?1
     UNION ALL SELECT 1 FROM conversations WHERE buyer_id = ?1 OR seller_id = ?1
     UNION ALL SELECT 1 FROM reports WHERE reporter_id = ?1 OR seller_id = ?1
     UNION ALL SELECT 1 FROM chat_reports WHERE reporter_id = ?1 OR reported_party_id = ?1
     LIMIT 1`,
  )
    .bind(userId)
    .first();
  if (!retained) {
    // Nothing else refers to the account, so its listings (only referenced by the records above) go with it.
    await db.batch([
      db.delete(listings).where(eq(listings.sellerId, userId)),
      db.delete(subscriptions).where(eq(subscriptions.userId, userId)),
      db.delete(regionVerifications).where(eq(regionVerifications.userId, userId)),
      db.delete(userSchools).where(eq(userSchools.userId, userId)),
      db.delete(pushDevices).where(eq(pushDevices.userId, userId)),
      db.delete(passkeys).where(eq(passkeys.userId, userId)),
      db.delete(schoolRequests).where(eq(schoolRequests.userId, userId)),
      db.delete(studentIdVerifications).where(eq(studentIdVerifications.userId, userId)),
      db.delete(oneTimeTokens).where(eq(oneTimeTokens.userId, userId)),
      db.delete(refreshTokens).where(eq(refreshTokens.userId, userId)),
      db.delete(staffManagedRegions).where(eq(staffManagedRegions.userId, userId)),
      db.delete(users).where(eq(users.id, userId)),
    ]);
    await disconnectUser(env, userId);
    await deleteListingPhotos(
      env,
      siteOrigin(env),
      userId,
      own.flatMap((l) => parsePhotos(l.photos)),
    );
    return;
  }
  await db.batch([
    // Other modules' tables. Listings stay as records (orders and reports
    // point at them) but lose what was personal: the private note and photos.
    db.update(listings).set({ status: 'removed', privateNote: '', photos: '[]', updatedAt: now }).where(eq(listings.sellerId, userId)),
    db.delete(subscriptions).where(eq(subscriptions.userId, userId)),
    // Ours.
    db.delete(regionVerifications).where(eq(regionVerifications.userId, userId)),
    db.delete(userSchools).where(eq(userSchools.userId, userId)),
    db.delete(pushDevices).where(eq(pushDevices.userId, userId)),
    db.delete(passkeys).where(eq(passkeys.userId, userId)),
    db
      .update(schoolRequests)
      .set({ eduEmail: '' })
      .where(and(eq(schoolRequests.userId, userId), ne(schoolRequests.eduEmail, ''))),
    cancelEmailChangeStatement(db, userId),
    db
      .update(users)
      .set({
        email: `deleted-${hex}@deleted.invalid`,
        firstName: 'Deleted account',
        lastName: '',
        name: 'Deleted account',
        avatarUrl: '',
        googleId: null,
        passwordHash: null,
        isActive: 0,
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userId)),
  ]);
  await revokeAllTokensForUser(env, userId);
  await disconnectUser(env, userId);
  // Their photos are public at fixed URLs: take them off the media host too.
  await deleteListingPhotos(
    env,
    siteOrigin(env),
    userId,
    own.flatMap((l) => parsePhotos(l.photos)),
  );
}
