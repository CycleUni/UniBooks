import type { Env } from '../../env';
import { generateSecureToken, generateSHA256 } from '../../lib/crypto';

/**
 * Single-use links mailed to users:
 * registration, campus email, password reset, email change.
 *
 * Only the SHA-256 of a token is stored. `read` validates without consuming
 * (a rejected new password leaves the link usable); `consume` is a
 * conditional UPDATE ... WHERE used_at IS NULL, so of two concurrent uses of
 * the same link exactly one succeeds.
 */

export const REGISTER = 'register';
export const EDU_VERIFY = 'edu_verify';
export const PASSWORD_RESET = 'password_reset';
export const EMAIL_CHANGE = 'email_change';

export const REGISTER_TTL = 86400;
export const EDU_VERIFY_TTL = 86400;
export const PASSWORD_RESET_TTL = 3600;
export const EMAIL_CHANGE_TTL = 3600;

export interface OneTimeRecord {
  id: string;
  userId: string;
  payload: Record<string, string>;
}

export async function issue(
  env: Env,
  purpose: string,
  userId: string,
  ttlSeconds: number,
  payload: Record<string, string> = {},
): Promise<string> {
  const token = generateSecureToken(32);
  const now = new Date();
  await env.DB.prepare(
    'INSERT INTO one_time_tokens (id, token_hash, user_id, purpose, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      crypto.randomUUID(),
      await generateSHA256(token),
      userId,
      purpose,
      JSON.stringify(payload),
      new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      now.toISOString(),
    )
    .run();
  return token;
}

/** The live, unused record for this token, or null. Does not consume it. */
export async function read(env: Env, purpose: string, token: unknown): Promise<OneTimeRecord | null> {
  if (typeof token !== 'string' || !token || token.length > 256) return null;
  const row = await env.DB.prepare(
    'SELECT id, user_id, payload FROM one_time_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?',
  )
    .bind(await generateSHA256(token), purpose, new Date().toISOString())
    .first<{ id: string; user_id: string; payload: string | null }>();
  if (!row) return null;
  let payload: Record<string, string> = {};
  try {
    payload = row.payload ? JSON.parse(row.payload) : {};
  } catch {
    payload = {};
  }
  return { id: row.id, userId: row.user_id, payload };
}

/** Mark the record used. False when someone else already did (a concurrent use). */
export async function consume(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE one_time_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .bind(new Date().toISOString(), id)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/** Undo a consume whose follow-up failed, so the visitor can open the same link again. */
export async function unconsume(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE one_time_tokens SET used_at = NULL WHERE id = ?').bind(id).run();
}

/** One outstanding email change per user: a new request supersedes the previous link. */
export async function issueEmailChange(env: Env, userId: string, email: string): Promise<string> {
  await cancelEmailChange(env, userId);
  return issue(env, EMAIL_CHANGE, userId, EMAIL_CHANGE_TTL, { email });
}

/** The address this user asked to move to but has not confirmed, or null. */
export async function pendingEmailChange(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT payload FROM one_time_tokens
     WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId, EMAIL_CHANGE, new Date().toISOString())
    .first<{ payload: string | null }>();
  if (!row?.payload) return null;
  try {
    return (JSON.parse(row.payload) as { email?: string }).email ?? null;
  } catch {
    return null;
  }
}

export function cancelEmailChangeStatement(env: Env, userId: string) {
  return env.DB.prepare('DELETE FROM one_time_tokens WHERE user_id = ? AND purpose = ?').bind(userId, EMAIL_CHANGE);
}

export async function cancelEmailChange(env: Env, userId: string): Promise<void> {
  await cancelEmailChangeStatement(env, userId).run();
}

/** Housekeeping for the cleanup cron: expired links and links already used. */
export async function purgeOneTimeTokens(env: Env): Promise<number> {
  const res = await env.DB.prepare('DELETE FROM one_time_tokens WHERE expires_at <= ? OR used_at IS NOT NULL')
    .bind(new Date().toISOString())
    .run();
  return res.meta.changes ?? 0;
}

/**
 * A row created by /register/ whose owner never followed the link: inactive,
 * never signed in, no Google link, not banned or deleted, and with a
 * registration link on record. Such a row proves nothing about who owns the
 * address, so it must not block (or be claimable against) the real owner.
 */
export async function isPendingRegistration(
  env: Env,
  user: { id: string; isActive: number; isBanned: number; deletedAt: string | null; lastLoginAt: string | null; googleId: string | null },
): Promise<boolean> {
  if (user.isActive || user.isBanned || user.deletedAt || user.lastLoginAt || user.googleId) return false;
  const row = await env.DB.prepare('SELECT 1 AS x FROM one_time_tokens WHERE user_id = ? AND purpose = ? LIMIT 1')
    .bind(user.id, REGISTER)
    .first();
  return !!row;
}

/** Void every outstanding registration link of a user. */
export async function voidRegistrationLinks(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE one_time_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL')
    .bind(new Date().toISOString(), userId, REGISTER)
    .run();
}

/** Password hashes carried by a user's still-valid registration links. */
export async function pendingRegistrationHashes(env: Env, userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT payload FROM one_time_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?',
  )
    .bind(userId, REGISTER, new Date().toISOString())
    .all<{ payload: string | null }>();
  const hashes: string[] = [];
  for (const r of results) {
    try {
      const h = r.payload ? (JSON.parse(r.payload) as Record<string, string>).password_hash : undefined;
      if (h) hashes.push(h);
    } catch {
      /* ignore */
    }
  }
  return hashes;
}
