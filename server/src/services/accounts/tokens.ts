import type { Env } from '../../env';
import { apiError } from '../../lib/http';
import { InvalidTokenError, signToken, verifyToken } from '../../lib/jwt';
import { newHexId } from '../../lib/uuid';
import { nowIso } from '../../lib/time';

/**
 * The refresh-token whitelist, one refresh_tokens row per jti.
 *
 *  - A live token has rotated_at NULL. Revoking a live token deletes its row.
 *  - Rotation keeps the row, stamps rotated_at and stores the pair it was
 *    rotated into, so a replay of the old token is recognisable:
 *      within ROTATION_GRACE  -> the SAME pair is handed back (two tabs racing),
 *      after it               -> 401 and the token's family (that sign-in's
 *                                chain) loses its live token.
 *  - family_id is the jti of the chain's first token.
 *
 * Store failures answer 503 auth.errSessionStoreUnavailable: a 401 would sign the visitor out for our outage.
 */

export const REFRESH_LIFETIME_SECONDS = 14 * 24 * 60 * 60;
export const ROTATION_GRACE_SECONDS = 60;

export interface TokenPair {
  access: string;
  refresh: string;
}

interface TokenRow {
  jti: string;
  user_id: string;
  family_id: string;
  rotated_at: string | null;
  rotated_tokens: string | null;
}

async function strict<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    console.error('[tokens] store unavailable', e);
    apiError(503, 'auth.errSessionStoreUnavailable');
  }
}

async function safe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (e) {
    console.error('[tokens] store error', e);
    return fallback;
  }
}

async function mintPair(env: Env, userId: string, family: string | null): Promise<{ jti: string; family: string; pair: TokenPair }> {
  const jti = newHexId();
  const familyId = family ?? jti;
  const [access, refresh] = await Promise.all([
    signToken('access', { user_id: userId }, env.JWT_SIGNING_KEY),
    signToken('refresh', { user_id: userId, jti, family_id: familyId }, env.JWT_SIGNING_KEY),
  ]);
  return { jti, family: familyId, pair: { access, refresh } };
}

function insertStatement(env: Env, jti: string, userId: string, family: string) {
  const now = new Date();
  return env.DB.prepare(
    'INSERT INTO refresh_tokens (id, jti, user_id, family_id, is_revoked, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
  ).bind(jti, jti, userId, family, new Date(now.getTime() + REFRESH_LIFETIME_SECONDS * 1000).toISOString(), now.toISOString());
}

/** Issue a pair and whitelist its refresh token. `family` continues a chain; omitted, a new one starts. */
export async function issueTokens(env: Env, userId: string, family: string | null = null): Promise<TokenPair> {
  const { jti, family: familyId, pair } = await mintPair(env, userId, family);
  await strict(() => insertStatement(env, jti, userId, familyId).run());
  return pair;
}

async function lookup(env: Env, jti: string): Promise<TokenRow | null> {
  return env.DB.prepare('SELECT jti, user_id, family_id, rotated_at, rotated_tokens FROM refresh_tokens WHERE jti = ? AND expires_at > ?')
    .bind(jti, nowIso())
    .first<TokenRow>();
}

/** "Log out all devices" / password change / reset: every live token the user has. */
export async function revokeAllTokensForUser(env: Env, userId: string): Promise<void> {
  await safe(() => env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND rotated_at IS NULL').bind(userId).run(), null);
}

async function revokeFamily(env: Env, family: string, userId: string): Promise<void> {
  await safe(
    () =>
      env.DB.prepare('DELETE FROM refresh_tokens WHERE family_id = ? AND user_id = ? AND rotated_at IS NULL').bind(family, userId).run(),
    null,
  );
}

/**
 * Logout of one token: revoke it if it is a live token of `userId`. A row
 * that names a different owner is a forgery signal and ends that owner's
 * sessions.
 */
export async function verifyAndRevokeRefreshToken(env: Env, jti: string, userId: string): Promise<boolean> {
  const row = await safe(() => lookup(env, jti), null);
  if (!row) return false;
  if (row.user_id !== userId) {
    console.warn(`[tokens] refresh jti=${jti} user mismatch`);
    await revokeAllTokensForUser(env, row.user_id);
    return false;
  }
  if (row.rotated_at) return false;
  await safe(() => env.DB.prepare('DELETE FROM refresh_tokens WHERE jti = ? AND rotated_at IS NULL').bind(jti).run(), null);
  return true;
}

function graceTokens(row: TokenRow): TokenPair | null {
  if (!row.rotated_at || !row.rotated_tokens) return null;
  if (Date.now() - Date.parse(row.rotated_at) > ROTATION_GRACE_SECONDS * 1000) return null;
  try {
    const pair = JSON.parse(row.rotated_tokens) as TokenPair;
    return pair?.access && pair?.refresh ? pair : null;
  } catch {
    return null;
  }
}

/**
 * POST /auth/refresh/. Throws the API error to
 * answer; returns the pair otherwise.
 */
export async function rotateRefreshToken(env: Env, raw: string): Promise<TokenPair> {
  let claims: { jti: string; user_id: string };
  try {
    claims = await verifyToken('refresh', raw, env.JWT_SIGNING_KEY);
  } catch (e) {
    if (e instanceof InvalidTokenError) apiError(401, 'auth.errInvalidToken');
    throw e;
  }
  const { jti, user_id: userId } = claims;
  if (typeof jti !== 'string' || !jti) apiError(401, 'auth.errInvalidToken');

  const row = await strict(() => lookup(env, jti));

  if (row && row.rotated_at && row.user_id === userId) {
    // Rotated already. Two tabs racing: the pair it became. Later: a replay.
    const pair = graceTokens(row);
    if (pair) return pair;
    console.warn(`[tokens] refresh jti=${jti} replayed after the grace window; revoking its family`);
    await revokeFamily(env, row.family_id || row.jti, userId);
    apiError(401, 'auth.errTokenRevoked');
  }

  if (!row) apiError(401, 'auth.errTokenRevoked');
  if (row.user_id !== userId) {
    console.warn(`[tokens] refresh jti=${jti} user mismatch`);
    await revokeAllTokensForUser(env, row.user_id);
    apiError(401, 'auth.errTokenRevoked');
  }

  const user = await strict(() =>
    env.DB.prepare('SELECT id, is_active, is_banned FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: string; is_active: number; is_banned: number }>(),
  );
  if (!user) apiError(401, 'auth.errInvalidToken');
  if (!user.is_active || user.is_banned) {
    await verifyAndRevokeRefreshToken(env, jti, userId);
    apiError(403, 'auth.errAccountDisabled');
  }

  // Record the new pair and retire the old token in one transaction; the
  // retirement is conditional, so of two concurrent rotations exactly one wins.
  const minted = await mintPair(env, userId, row.family_id || row.jti);
  const results = await strict(() =>
    env.DB.batch([
      insertStatement(env, minted.jti, userId, minted.family),
      env.DB.prepare('UPDATE refresh_tokens SET rotated_at = ?, rotated_tokens = ? WHERE jti = ? AND rotated_at IS NULL').bind(
        nowIso(),
        JSON.stringify(minted.pair),
        jti,
      ),
    ]),
  );
  if ((results[1]?.meta?.changes ?? 0) === 1) return minted.pair;

  // Lost the race: drop our pair and hand back the one the winner stored.
  await safe(() => env.DB.prepare('DELETE FROM refresh_tokens WHERE jti = ?').bind(minted.jti).run(), null);
  const winner = await strict(() => lookup(env, jti));
  const pair = winner ? graceTokens(winner) : null;
  if (pair) return pair;
  apiError(401, 'auth.errTokenRevoked');
}

/** Housekeeping for the cleanup cron. */
export async function purgeTokenStore(env: Env): Promise<number> {
  const now = nowIso();
  const graceCutoff = new Date(Date.now() - ROTATION_GRACE_SECONDS * 1000).toISOString();
  const [deleted, blanked] = await env.DB.batch([
    env.DB.prepare('DELETE FROM refresh_tokens WHERE expires_at <= ?').bind(now),
    env.DB.prepare('UPDATE refresh_tokens SET rotated_tokens = NULL WHERE rotated_at <= ? AND rotated_tokens IS NOT NULL').bind(
      graceCutoff,
    ),
  ]);
  return (deleted.meta.changes ?? 0) + (blanked.meta.changes ?? 0);
}
