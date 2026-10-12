import type { Env } from '../../env';
import { activeRegionDetails, schoolDomains, type Row } from './regionData';

/**
 * Campus email rules.
 */

export interface ResolvedSchool {
  school: Row & { id: number; region_code: string };
  regionCode: string;
}

/** A plain, single address. */
export function isPlainEmail(value: string): boolean {
  if (value.length > 254) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(value);
}

/**
 * The School an address belongs to, matching its domain and every parent
 * domain (mail.ntu.edu.tw -> ntu.edu.tw), most specific first.
 */
export async function resolveSchoolFromEmail(env: Env, email: string | null | undefined): Promise<ResolvedSchool | null> {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@').pop()!.toLowerCase();
  const { results } = await env.DB.prepare('SELECT * FROM schools WHERE is_active = 1').all<Row>();
  const byDomain = new Map<string, Row>();
  for (const row of results) for (const d of schoolDomains(row)) if (!byDomain.has(d)) byDomain.set(d, row);
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const hit = byDomain.get(parts.slice(i).join('.'));
    if (hit) {
      return {
        school: hit as ResolvedSchool['school'],
        regionCode: String(hit.region_code ?? hit.region_id).toUpperCase(),
      };
    }
  }
  return null;
}

/**
 * Whether `email` looks like a campus address: a registered school's domain,
 * or (fallback, so an unknown campus gets acct.errSchoolNotSupported rather
 * than acct.errEduEmail) an active region's edu suffix.
 */
export async function isValidEduEmail(env: Env, email: string): Promise<boolean> {
  if (await resolveSchoolFromEmail(env, email)) return true;
  const regions = await activeRegionDetails(env);
  return regions.some((r) => r.eduEmailSuffix.some((suffix) => email.endsWith(suffix)));
}

/**
 * Whether another account holds `email`, as its sign-in address or as a
 * campus address. Every verification row counts, active or not: the column
 * is unique, and an unbound row still owns its address.
 */
export async function emailAlreadyUsed(env: Env, email: string, excludingUserId: string): Promise<boolean> {
  const lower = email.toLowerCase();
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM users WHERE lower(email) = ? AND id != ?
     UNION ALL
     SELECT 1 FROM region_verifications WHERE lower(edu_email) = ? AND user_id != ?
     LIMIT 1`,
  )
    .bind(lower, excludingUserId, lower, excludingUserId)
    .first();
  return !!row;
}

/**
 * update_or_create the user's verification in `regionCode`. False when the
 * address is already some other row's (the unique constraint caught a race
 * the emailAlreadyUsed check missed).
 */
export async function upsertVerification(
  env: Env,
  userId: string,
  regionCode: string,
  schoolId: number,
  eduEmail: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO region_verifications
         (user_id, region_code, school_id, edu_email, is_manual_verification, verified_at, expires_at, is_active, created_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, 1, ?)
       ON CONFLICT (user_id, region_code) DO UPDATE SET
         school_id = excluded.school_id,
         edu_email = excluded.edu_email,
         verified_at = excluded.verified_at,
         expires_at = NULL,
         is_active = 1`,
    )
      .bind(userId, regionCode, schoolId, eduEmail.toLowerCase(), now, now)
      .run();
    return true;
  } catch (e) {
    if (String(e).includes('UNIQUE')) return false;
    throw e;
  }
}
