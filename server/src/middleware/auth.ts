import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
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

/**
 * In-memory map bounding write volume to Workers Analytics Engine.
 * Key: userId, Value: timestamp ms of last recorded activity on this isolate.
 *
 * Why this does not distort daily active counts:
 * DAU and MAU metrics count distinct active accounts over a calendar bucket (day or month).
 * As long as an active user generates at least one recorded data point within the period,
 * their unique participation is counted. Limiting writes to at most once per 5 minutes per
 * user per isolate keeps write volume and CPU overhead low while capturing every day the user
 * is active with zero distortion of distinct daily or monthly counts.
 */
const ACTIVITY_THROTTLE_MS = 5 * 60_000;
const MAX_THROTTLE_ENTRIES = 10_000;
const activityThrottle = new Map<string, number>();

/** For unit tests. */
export function _resetActivityThrottle(): void {
  activityThrottle.clear();
}

function shouldThrottleUser(userId: string, now: number): boolean {
  const last = activityThrottle.get(userId);
  if (last !== undefined && now - last < ACTIVITY_THROTTLE_MS) {
    return true;
  }
  if (activityThrottle.size >= MAX_THROTTLE_ENTRIES) {
    for (const [id, ts] of activityThrottle.entries()) {
      if (now - ts >= ACTIVITY_THROTTLE_MS) {
        activityThrottle.delete(id);
      }
    }
  }
  activityThrottle.set(userId, now);
  return false;
}

/**
 * Filter out traffic that should not count as active user participation:
 * 1. Staff admin API calls (/api/v1/admin/*): staff performing administrative actions
 *    must not inflate consumer marketplace activity.
 * 2. Token refresh (/api/v1/auth/refresh): the client SessionRefreshService automatically
 *    refreshes access tokens in the background on timers. Counting refresh would cause
 *    an unattended open browser tab to register as active forever.
 * 3. Chat/hub endpoints (/api/chat/*): chat hub WebSockets (/api/chat/hub) and snapshot
 *    checks (/api/chat/hub/snapshot) maintain long-lived or automated background connections
 *    with automated pings/reconnects without user action.
 */
export function shouldRecordActivity(path: string): boolean {
  if (path.startsWith('/api/v1/admin')) return false;
  if (path === '/api/v1/auth/refresh' || path.endsWith('/auth/refresh') || path.endsWith('/refresh')) return false;
  if (path.startsWith('/api/chat')) return false;
  return true;
}

function recordActivity(c: Parameters<MiddlewareHandler<AppEnv>>[0], user: AuthUser): void {
  try {
    const dataset = c.env.ACTIVITY_EVENTS;
    if (!dataset) return;
    if (!shouldRecordActivity(c.req.path)) return;
    const now = Date.now();
    if (shouldThrottleUser(user.id, now)) return;
    const regionCode = (c.get('region') ?? c.req.query('region') ?? c.req.header('X-Region') ?? getCookie(c, 'region') ?? '')
      .trim()
      .toUpperCase();
    dataset.writeDataPoint({
      indexes: [user.id],
      blobs: [regionCode || '', user.id],
      doubles: [1],
    });
  } catch {
    // Activity recording must never throw or affect the request path
  }
}

function setUser(c: Parameters<MiddlewareHandler<AppEnv>>[0], { authTime, ...user }: AuthUser & { authTime: number }) {
  c.set('user', user);
  c.set('userId', user.id);
  c.set('authTime', authTime);
  recordActivity(c, user);
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
 * one, kept alive by refreshes — must not be able to plant a passkey, take one
 * away, or delete the account. Use after authMiddleware.
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
