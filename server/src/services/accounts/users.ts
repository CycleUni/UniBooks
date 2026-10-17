import type { Context } from 'hono';
import { and, asc, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppEnv, Env } from '../../env';
import {
  createDb,
  listings,
  passkeys,
  pushDevices,
  regionVerifications,
  reviews,
  schoolRequests,
  staffManagedRegions,
  subscriptions,
  users,
  type User,
} from '../../db';
import { getRegion } from '../../lib/region';
import { resolveLanguage } from './i18n';
import { localizedName, type Row } from './regionData';
import { cancelEmailChangeStatement } from './oneTimeTokens';
import { revokeAllTokensForUser } from './tokens';
import { newHexId } from '../../lib/uuid';
import { cancelOpenOrdersForUser } from '../orders/cancel';
import { disconnectUser } from '../messaging/disconnect';

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
  verified_at: string;
}

/** The user's live verifications (active, verified, unexpired), sorted by region, with their schools. */
export async function verificationsOf(env: Env, userId: string): Promise<(VerificationRow & { school: Row | null })[]> {
  const results: VerificationRow[] = await createDb(env.DB)
    .select({
      region_code: regionVerifications.regionCode,
      school_id: regionVerifications.schoolId,
      edu_email: regionVerifications.eduEmail,
      verified_at: regionVerifications.verifiedAt,
    })
    .from(regionVerifications)
    .where(
      and(
        eq(regionVerifications.userId, userId),
        eq(regionVerifications.isActive, 1),
        isNotNull(regionVerifications.verifiedAt),
        or(isNull(regionVerifications.expiresAt), gt(regionVerifications.expiresAt, new Date().toISOString())),
      ),
    )
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
  const [region, lang, verifications, reputation, managedRegions] = await Promise.all([
    getRegion(c),
    resolveLanguage(c),
    verificationsOf(c.env, user.id),
    reputationOf(c.env, user.id),
    isStaff ? managedRegionsOf(c.env, user.id) : Promise.resolve([]),
  ]);
  const regions = verifications.map((v) => v.region_code.toUpperCase());
  // The verification in the region being browsed; without a region, the first.
  const current = region
    ? (verifications.find((v) => v.region_code.toUpperCase() === region.code.toUpperCase()) ?? null)
    : (verifications[0] ?? null);

  return {
    id: user.id,
    email: user.email,
    edu_email: current ? current.edu_email : null,
    first_name: user.firstName,
    last_name: user.lastName,
    display_name: displayName(user.firstName, user.lastName),
    school: current ? current.school_id : null,
    school_name: current?.school ? localizedName(current.school, lang) : '',
    is_active: !!user.isActive,
    is_verified: !!current,
    verified_at: current ? current.verified_at : null,
    ...reputation,
    has_password: !!user.passwordHash,
    is_google_linked: !!user.googleId,
    avatar_url: user.avatarUrl || null,
    show_avatar: !!user.showAvatar,
    last_seen_bought_orders_at: user.lastSeenBoughtOrdersAt ?? null,
    last_seen_sold_orders_at: user.lastSeenSoldOrdersAt ?? null,
    role: user.role,
    managed_regions: managedRegions,
    regions,
    verifications: verifications.map((v) => ({
      region: v.region_code.toUpperCase(),
      school: v.school_id,
      school_code: v.school ? String(v.school.code ?? '') : '',
      school_name: v.school ? localizedName(v.school, lang) : '',
      edu_email: v.edu_email,
      verified_at: v.verified_at,
    })),
    site_language: user.siteLanguage,
    // Blank once the verification it was saved under has ended.
    site_region: regions.includes(user.siteRegion) ? user.siteRegion : '',
  };
}

/** The public view of a user's profile. */
export async function serializePublicUser(c: Context<AppEnv>, user: User): Promise<Record<string, unknown>> {
  const [region, lang, verifications, reputation] = await Promise.all([
    getRegion(c),
    resolveLanguage(c),
    verificationsOf(c.env, user.id),
    reputationOf(c.env, user.id),
  ]);
  const current = region
    ? (verifications.find((v) => v.region_code.toUpperCase() === region.code.toUpperCase()) ?? null)
    : (verifications[0] ?? null);
  return {
    id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    display_name: displayName(user.firstName, user.lastName),
    school_name: current?.school ? localizedName(current.school, lang) : '',
    created_at: user.createdAt,
    is_verified: !!current,
    ...reputation,
    avatar_url: publicAvatarUrl(user),
  };
}

/** The columns a first/last name change touches, `name` included. */
export function nameColumns(firstName: string, lastName: string) {
  return { firstName, lastName, name: displayName(firstName, lastName) };
}

/**
 * "Deleting" an account empties it rather than removing the row: orders and reviews point at it from both sides, and a real
 * delete would take the other party's history with it.
 */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  // First, through each order's lock: the other party is told and any
  // reservation released, rather than an open order left on a gone listing.
  await cancelOpenOrdersForUser(env, userId);
  const now = new Date().toISOString();
  const hex = newHexId();
  const db = createDb(env.DB);
  await db.batch([
    // Other modules' tables.
    db
      .update(listings)
      .set({ status: 'removed', updatedAt: now })
      .where(and(eq(listings.sellerId, userId), ne(listings.status, 'removed'))),
    db.delete(subscriptions).where(eq(subscriptions.userId, userId)),
    // Ours.
    db.delete(regionVerifications).where(eq(regionVerifications.userId, userId)),
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
}
