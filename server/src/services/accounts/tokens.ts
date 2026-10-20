import { and, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Env } from '../../env';
import { createDb, refreshTokens, users, type Database } from '../../db';
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

async function mintPair(
  env: Env,
  userId: string,
  family: string | null,
  authTime: number,
): Promise<{ jti: string; family: string; pair: TokenPair }> {
  const jti = newHexId();
  const familyId = family ?? jti;
  const [access, refresh] = await Promise.all([
    signToken('access', { user_id: userId, auth_time: authTime }, env),
    signToken('refresh', { user_id: userId, jti, family_id: familyId, auth_time: authTime }, env),
  ]);
  return { jti, family: familyId, pair: { access, refresh } };
}

function insertStatement(db: Database, jti: string, userId: string, family: string) {
  const now = new Date();
  return db.insert(refreshTokens).values({
    id: jti,
    jti,
    userId,
    familyId: family,
    isRevoked: 0,
    expiresAt: new Date(now.getTime() + REFRESH_LIFETIME_SECONDS * 1000).toISOString(),
    createdAt: now.toISOString(),
  });
}

/** Issue a pair for a sign-in that just happened, and whitelist its refresh token. A new chain starts. */
export async function issueTokens(env: Env, userId: string): Promise<TokenPair> {
  const { jti, family: familyId, pair } = await mintPair(env, userId, null, Math.floor(Date.now() / 1000));
  await strict(() => insertStatement(createDb(env.DB), jti, userId, familyId).run());
  return pair;
}

async function lookup(env: Env, jti: string): Promise<TokenRow | null> {
  const [row] = await createDb(env.DB)
    .select({
      jti: refreshTokens.jti,
      user_id: refreshTokens.userId,
      family_id: refreshTokens.familyId,
      rotated_at: refreshTokens.rotatedAt,
      rotated_tokens: refreshTokens.rotatedTokens,
    })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.jti, jti), gt(refreshTokens.expiresAt, nowIso())))
    .limit(1);
  return row ?? null;
}

/** "Log out all devices" / password change / reset: every live token the user has. */
export async function revokeAllTokensForUser(env: Env, userId: string): Promise<void> {
  await safe(
    () =>
      createDb(env.DB)
        .delete(refreshTokens)
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.rotatedAt)))
        .run(),
    null,
  );
}

async function revokeFamily(env: Env, family: string, userId: string): Promise<void> {
  await safe(
    () =>
      createDb(env.DB)
        .delete(refreshTokens)
        .where(and(eq(refreshTokens.familyId, family), eq(refreshTokens.userId, userId), isNull(refreshTokens.rotatedAt)))
        .run(),
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
  await safe(
    () =>
      createDb(env.DB)
        .delete(refreshTokens)
        .where(and(eq(refreshTokens.jti, jti), isNull(refreshTokens.rotatedAt)))
        .run(),
    null,
  );
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
  let claims: { jti: string; user_id: string; auth_time?: number };
  try {
    claims = await verifyToken('refresh', raw, env);
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

  const db = createDb(env.DB);
  const [user] = await strict(() =>
    db.select({ id: users.id, isActive: users.isActive, isBanned: users.isBanned }).from(users).where(eq(users.id, userId)).limit(1),
  );
  if (!user) apiError(401, 'auth.errInvalidToken');
  if (!user.isActive || user.isBanned) {
    await verifyAndRevokeRefreshToken(env, jti, userId);
    apiError(403, 'auth.errAccountDisabled');
  }

  // Record the new pair and retire the old token in one transaction; the
  // retirement is conditional, so of two concurrent rotations exactly one wins.
  // A refresh is not a sign-in: the new pair keeps the chain's sign-in time.
  const minted = await mintPair(env, userId, row.family_id || row.jti, claims.auth_time ?? 0);
  const [, retired] = await strict(() =>
    db.batch([
      insertStatement(db, minted.jti, userId, minted.family),
      db
        .update(refreshTokens)
        .set({ rotatedAt: nowIso(), rotatedTokens: JSON.stringify(minted.pair) })
        .where(and(eq(refreshTokens.jti, jti), isNull(refreshTokens.rotatedAt))),
    ]),
  );
  if ((retired.meta?.changes ?? 0) === 1) return minted.pair;

  // Lost the race: drop our pair and hand back the one the winner stored.
  await safe(() => db.delete(refreshTokens).where(eq(refreshTokens.jti, minted.jti)).run(), null);
  const winner = await strict(() => lookup(env, jti));
  const pair = winner ? graceTokens(winner) : null;
  if (pair) return pair;
  apiError(401, 'auth.errTokenRevoked');
}

/** Housekeeping for the cleanup cron. */
export async function purgeTokenStore(env: Env): Promise<number> {
  const now = nowIso();
  const graceCutoff = new Date(Date.now() - ROTATION_GRACE_SECONDS * 1000).toISOString();
  const db = createDb(env.DB);
  const [deleted, blanked] = await db.batch([
    db.delete(refreshTokens).where(lte(refreshTokens.expiresAt, now)),
    db
      .update(refreshTokens)
      .set({ rotatedTokens: null })
      .where(and(lte(refreshTokens.rotatedAt, graceCutoff), isNotNull(refreshTokens.rotatedTokens))),
  ]);
  return (deleted.meta.changes ?? 0) + (blanked.meta.changes ?? 0);
}
