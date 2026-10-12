import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppEnv, Env } from '../../env';
import { createDb, users, type User } from '../../db';
import { getRegion } from '../../lib/region';
import { resolveLanguage } from './i18n';
import { localizedName, type Row } from './regionData';
import { cancelEmailChangeStatement } from './oneTimeTokens';
import { revokeAllTokensForUser } from './tokens';

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
  const row = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 1').bind(email.trim()).first<{ id: string }>();
  return row ? getUser(env, row.id) : null;
}

interface VerificationRow {
  region_code: string;
  school_id: number | null;
  edu_email: string | null;
  verified_at: string;
}

/** The user's live verifications (active, verified, unexpired), sorted by region, with their schools. */
export async function verificationsOf(env: Env, userId: string): Promise<(VerificationRow & { school: Row | null })[]> {
  const { results } = await env.DB.prepare(
    `SELECT region_code, school_id, edu_email, verified_at FROM region_verifications
     WHERE user_id = ? AND is_active = 1 AND verified_at IS NOT NULL
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY region_code`,
  )
    .bind(userId, new Date().toISOString())
    .all<VerificationRow>();
  const ids = [...new Set(results.map((r) => r.school_id).filter((id): id is number => id !== null))];
  const schools = new Map<number, Row>();
  if (ids.length) {
    const { results: rows } = await env.DB.prepare(`SELECT * FROM schools WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids))
      .all<Row>();
    for (const s of rows) schools.set(Number(s.id), s);
  }
  return results.map((r) => ({ ...r, school: r.school_id !== null ? (schools.get(r.school_id) ?? null) : null }));
}

/** Average rating, review count and no-show count. */
export async function reputationOf(env: Env, userId: string) {
  const row = await env.DB.prepare(
    `SELECT
       AVG(CASE WHEN is_no_show = 0 AND rating IS NOT NULL THEN rating END) AS avg,
       SUM(CASE WHEN is_no_show = 0 AND rating IS NOT NULL THEN 1 ELSE 0 END) AS reviews,
       SUM(CASE WHEN is_no_show = 1 THEN 1 ELSE 0 END) AS no_shows
     FROM reviews WHERE reviewee_id = ?`,
  )
    .bind(userId)
    .first<{ avg: number | null; reviews: number | null; no_shows: number | null }>()
    .catch(() => null);
  return {
    average_rating: row?.avg != null ? Math.round(row.avg * 10) / 10 : 0.0,
    review_count: Number(row?.reviews ?? 0),
    no_show_count: Number(row?.no_shows ?? 0),
  };
}

/** The regions a staff member manages. */
export async function managedRegionsOf(env: Env, userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT region_code FROM staff_managed_regions WHERE user_id = ?')
    .bind(userId)
    .all<{ region_code: string }>();
  return results.map((r) => String(r.region_code).toUpperCase()).sort();
}

/** The signed-in user's own view of their account. */
export async function serializeUser(c: Context<AppEnv>, user: User): Promise<Record<string, unknown>> {
  const [region, lang, verifications, reputation] = await Promise.all([
    getRegion(c),
    resolveLanguage(c),
    verificationsOf(c.env, user.id),
    reputationOf(c.env, user.id),
  ]);
  const regions = verifications.map((v) => v.region_code.toUpperCase());
  // The verification in the region being browsed; without a region, the first.
  const current = region
    ? (verifications.find((v) => v.region_code.toUpperCase() === region.code.toUpperCase()) ?? null)
    : (verifications[0] ?? null);
  const isStaff = isStaffRole(user.role);

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
    is_staff: isStaff,
    is_superuser: user.role === 'admin',
    managed_regions: isStaff ? await managedRegionsOf(c.env, user.id) : [],
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
  const now = new Date().toISOString();
  const hex = crypto.randomUUID().replace(/-/g, '');
  const stmts = [
    // Other modules' tables.
    env.DB.prepare("UPDATE listings SET status = 'removed', updated_at = ? WHERE seller_id = ? AND status != 'removed'").bind(now, userId),
    env.DB.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(userId),
    // Ours.
    env.DB.prepare('DELETE FROM region_verifications WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM push_devices WHERE user_id = ?').bind(userId),
    env.DB.prepare("UPDATE school_requests SET edu_email = '' WHERE user_id = ? AND edu_email != ''").bind(userId),
    cancelEmailChangeStatement(env, userId),
    env.DB.prepare(
      `UPDATE users SET email = ?, first_name = 'Deleted account', last_name = '', name = 'Deleted account',
         avatar_url = '', google_id = NULL, password_hash = NULL, is_active = 0, deleted_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(`deleted-${hex}@deleted.invalid`, now, now, userId),
  ];
  await env.DB.batch(stmts);
  await revokeAllTokensForUser(env, userId);
}
