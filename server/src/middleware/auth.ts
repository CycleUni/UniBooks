import type { Context, MiddlewareHandler } from 'hono';
import { accessTokenFrom } from '../lib/session';
import { eq } from 'drizzle-orm';
import type { AppEnv, AuthUser } from '../env';
import { createDb, users } from '../db';
import { verifyToken, InvalidTokenError } from '../lib/jwt';
import { apiError } from '../lib/http';

/**
 * Resolve the access token to a *current* user row. The token carries only
 * the user id: whether the account is still active, banned, or staff is read
 * from D1 on every request, so a ban or demotion takes effect immediately
 * rather than when the 15-minute token runs out.
 */
async function resolveUser(c: Parameters<MiddlewareHandler<AppEnv>>[0], token: string): Promise<(AuthUser & { authTime: number }) | null> {
  let userId: string;
  let authTime: number | undefined;
  try {
    ({ user_id: userId, auth_time: authTime } = await verifyToken('access', token, c.env));
  } catch (e) {
    if (e instanceof InvalidTokenError) return null;
    throw e;
  }
  const db = createDb(c.env.DB);
  const [row] = await db
    .select({ id: users.id, email: users.email, role: users.role, isActive: users.isActive, isBanned: users.isBanned })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || !row.isActive || row.isBanned) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    isStaff: row.role === 'staff' || row.role === 'admin',
    isAdmin: row.role === 'admin',
    authTime: typeof authTime === 'number' ? authTime : 0,
  };
}

function setUser(c: Parameters<MiddlewareHandler<AppEnv>>[0], { authTime, ...user }: AuthUser & { authTime: number }) {
  c.set('user', user);
  c.set('userId', user.id);
  c.set('authTime', authTime);
}

/** 401 {"error":{"code":"auth.errNotLoggedIn"}} without a valid access token. */
export const authMiddleware = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const token = accessTokenFrom(c);
  const user = token ? await resolveUser(c, token) : null;
  if (!user) apiError(401, 'auth.errNotLoggedIn');
  setUser(c, user);
  await next();
};

/** OptionalJWTAuthentication: a bad or absent token just means anonymous. */
export const optionalAuthMiddleware = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const token = accessTokenFrom(c);
  const user = token ? await resolveUser(c, token) : null;
  if (user) setUser(c, user);
  await next();
};

/** Staff only (403 otherwise). Use after authMiddleware. */
export const requireStaff = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!c.get('user')?.isStaff) apiError(403, 'admin.errForbiddenAction');
  await next();
};

/** Admin only. Use after authMiddleware. */
export const requireAdmin = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!c.get('user')?.isAdmin) apiError(403, 'admin.errForbiddenAction');
  await next();
};

/** How recent a sign-in must be for changes that add or remove a way into the account. */
export const RECENT_SIGN_IN_SECONDS = 15 * 60;

/**
 * 403 auth.errReauthRequired unless the user signed in (password, Google or
 * passkey) within RECENT_SIGN_IN_SECONDS. A session alone — possibly a stolen
 * one, kept alive by refreshes — must not be able to plant a passkey or take
 * one away. Use after authMiddleware.
 */
export const requireRecentSignIn = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  assertRecentSignIn(c);
  await next();
};

/** requireRecentSignIn() for a handler that needs it only on some inputs. */
export function assertRecentSignIn(c: Context<AppEnv>): void {
  const authTime = c.get('authTime') ?? 0;
  if (Math.floor(Date.now() / 1000) - authTime > RECENT_SIGN_IN_SECONDS) apiError(403, 'auth.errReauthRequired');
}
