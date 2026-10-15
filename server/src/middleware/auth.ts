import type { MiddlewareHandler } from 'hono';
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
async function resolveUser(c: Parameters<MiddlewareHandler<AppEnv>>[0], token: string): Promise<AuthUser | null> {
  let userId: string;
  try {
    ({ user_id: userId } = await verifyToken('access', token, c.env));
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
  };
}

function setUser(c: Parameters<MiddlewareHandler<AppEnv>>[0], user: AuthUser) {
  c.set('user', user);
  c.set('userId', user.id);
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
