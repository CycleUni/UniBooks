import type { Env } from '../../env';

/**
 * User fields the messaging module reads about *other* people (names,
 * avatars, notification switches, languages).
 *
 * Read with `SELECT *` and picked defensively: the accounts module owns the
 * users table and adds columns (first_name/last_name, show_avatar,
 * notify_push, notify_new_message_email, email_language, site_language,
 * deleted_at). Each has a default for when a column is
 * absent, so this keeps working whichever of them exist.
 */
export interface Person {
  id: string;
  email: string;
  displayName: string;
  publicAvatarUrl: string;
  isActive: boolean;
  isBanned: boolean;
  deleted: boolean;
  /** Role 'staff' or 'admin'. */
  isStaff: boolean;
  /** Role 'admin': every region. */
  isAdmin: boolean;
  notifyPush: boolean;
  notifyNewMessageEmail: boolean;
  emailLanguage: string;
  siteLanguage: string;
}

type Row = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const flag = (v: unknown, dflt: boolean) => (v === undefined || v === null ? dflt : v === 1 || v === true || v === '1');

/** "First Last" when either has Latin letters, else "LastFirst". */
export function displayNameOf(row: Row): string {
  if ('display_name' in row && str(row.display_name)) return str(row.display_name);
  if ('first_name' in row || 'last_name' in row) {
    const first = str(row.first_name);
    const last = str(row.last_name);
    if (first && last) return /[A-Za-z]/.test(first) || /[A-Za-z]/.test(last) ? `${first} ${last}` : `${last}${first}`;
    return `${last}${first}`.trim();
  }
  return str(row.name);
}

export function toPerson(row: Row): Person {
  const showAvatar = flag(row.show_avatar, true);
  return {
    id: str(row.id),
    email: str(row.email),
    displayName: displayNameOf(row),
    publicAvatarUrl: showAvatar ? str(row.avatar_url) : '',
    isActive: flag(row.is_active, true),
    isBanned: flag(row.is_banned, false),
    deleted: !!row.deleted_at,
    isStaff: row.role === 'staff' || row.role === 'admin',
    isAdmin: row.role === 'admin',
    notifyPush: flag(row.notify_push, true),
    notifyNewMessageEmail: flag(row.notify_new_message_email, true),
    emailLanguage: str(row.email_language) || 'auto',
    siteLanguage: str(row.site_language),
  };
}

export async function loadPeople(env: Env, ids: readonly string[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, Person>();
  if (!unique.length) return out;
  const { results } = await env.DB.prepare(`SELECT * FROM users WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(unique))
    .all<Row>();
  for (const row of results) out.set(str(row.id), toPerson(row));
  return out;
}

export async function loadPerson(env: Env, id: string): Promise<Person | null> {
  return (await loadPeople(env, [id])).get(id) ?? null;
}

/** Whether the account can currently use chat: active, not banned, not deleted. */
export function isUsable(p: Person | null | undefined): p is Person {
  return !!p && p.isActive && !p.isBanned && !p.deleted;
}

export interface UserSchoolInfo {
  schoolName: string;
  isVerified: boolean;
}

/**
 * Each user's school and verification status in `regionCode`:
 * resolved school (verified first, else declared), and whether they hold an active unexpired verification.
 */
export async function schoolInfosIn(env: Env, userIds: readonly string[], regionCode: string): Promise<Map<string, UserSchoolInfo>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, UserSchoolInfo>();
  if (!unique.length) return out;
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT
       u.value AS user_id,
       COALESCE(sv.name, sd.name, '') AS school_name,
       CASE WHEN rv.id IS NOT NULL THEN 1 ELSE 0 END AS is_verified
     FROM json_each(?) u
     LEFT JOIN region_verifications rv ON rv.user_id = u.value
       AND rv.region_code = ?
       AND rv.is_active = 1
       AND (rv.expires_at IS NULL OR rv.expires_at > ?)
     LEFT JOIN schools sv ON sv.id = rv.school_id
     LEFT JOIN user_schools us ON us.user_id = u.value
       AND us.region_code = ?
     LEFT JOIN schools sd ON sd.id = us.school_id`,
  )
    .bind(JSON.stringify(unique), regionCode, now, regionCode)
    .all<{ user_id: string; school_name: string; is_verified: number }>();
  for (const r of results) {
    out.set(r.user_id, {
      schoolName: r.school_name ?? '',
      isVerified: r.is_verified === 1,
    });
  }
  return out;
}

/**
 * Each user's school in `regionCode` (resolved school: verified, else declared),
 * '' when none.
 */
export async function schoolNamesIn(env: Env, userIds: readonly string[], regionCode: string): Promise<Map<string, string>> {
  const infos = await schoolInfosIn(env, userIds, regionCode);
  const out = new Map<string, string>();
  for (const [id, info] of infos.entries()) {
    out.set(id, info.schoolName);
  }
  return out;
}
