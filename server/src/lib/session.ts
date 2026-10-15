import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { apiError } from './http';

/**
 * Browser sessions live in HttpOnly cookies, so no script on the page — ours
 * or an injected one — can read a token.
 *
 *   __Host-ub_at   access token, 15 min. __Host- pins it to this exact origin
 *                  (Secure, Path=/, no Domain).
 *   __Secure-ub_rt refresh token, 14 days, sent only to /api/v1/auth/ and
 *                  never on cross-site requests (SameSite=Strict).
 *   ub_session     "1" while signed in: not a credential, just tells the SPA
 *                  whether to bother asking /auth/me/.
 *   ub_access      "1" while the access cookie is good, expiring a little
 *                  before it on the browser's own clock: its absence tells the
 *                  SPA to refresh before calling the API, instead of after a
 *                  401 on every request in flight.
 *
 * Non-browser clients may still send `Authorization: Bearer <access>`.
 */
export const ACCESS_COOKIE = '__Host-ub_at';
export const REFRESH_COOKIE = '__Secure-ub_rt';
export const HINT_COOKIE = 'ub_session';
export const ACCESS_HINT_COOKIE = 'ub_access';

const ACCESS_MAX_AGE = 15 * 60;
/** Refresh this long before the access cookie lapses, so no request races it. */
const ACCESS_HINT_MARGIN = 30;
const REFRESH_MAX_AGE = 14 * 24 * 60 * 60;
const REFRESH_PATH = '/api/v1/auth/';

export function setSession(c: Context<AppEnv>, pair: { access: string; refresh: string }): void {
  setCookie(c, ACCESS_COOKIE, pair.access, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: ACCESS_MAX_AGE });
  setCookie(c, REFRESH_COOKIE, pair.refresh, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: REFRESH_PATH,
    maxAge: REFRESH_MAX_AGE,
  });
  setCookie(c, HINT_COOKIE, '1', { secure: true, sameSite: 'Lax', path: '/', maxAge: REFRESH_MAX_AGE });
  setCookie(c, ACCESS_HINT_COOKIE, '1', { secure: true, sameSite: 'Lax', path: '/', maxAge: ACCESS_MAX_AGE - ACCESS_HINT_MARGIN });
}

export function clearSession(c: Context<AppEnv>): void {
  deleteCookie(c, ACCESS_COOKIE, { path: '/', secure: true });
  deleteCookie(c, REFRESH_COOKIE, { path: REFRESH_PATH, secure: true });
  deleteCookie(c, HINT_COOKIE, { path: '/', secure: true });
  deleteCookie(c, ACCESS_HINT_COOKIE, { path: '/', secure: true });
}

/**
 * `res` with the session cookies expired. For error responses: a thrown
 * HTTPException carries its own prebuilt Response, so cookies set on the
 * context before the throw never reach the client.
 */
export function withClearedSession(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.append('Set-Cookie', `${ACCESS_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  out.headers.append('Set-Cookie', `${REFRESH_COOKIE}=; Max-Age=0; Path=${REFRESH_PATH}; HttpOnly; Secure; SameSite=Strict`);
  out.headers.append('Set-Cookie', `${HINT_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Lax`);
  out.headers.append('Set-Cookie', `${ACCESS_HINT_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Lax`);
  return out;
}

/** The access token: Authorization header first (API clients), else the cookie. */
export function accessTokenFrom(c: Context<AppEnv>): string | null {
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return getCookie(c, ACCESS_COOKIE) ?? null;
}

/** The refresh token: the cookie, or a `refresh` field for API clients. */
export function refreshTokenFrom(c: Context<AppEnv>, body: Record<string, unknown>): string | null {
  const cookie = getCookie(c, REFRESH_COOKIE);
  if (cookie) return cookie;
  return typeof body.refresh === 'string' && body.refresh ? body.refresh : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests: a state-changing request
 * must come from this origin. Browsers mark every request with
 * Sec-Fetch-Site (and Origin on POST/PUT/PATCH/DELETE); a cross-site form or
 * fetch is refused before any handler runs. Requests with neither header
 * (curl, server-to-server) carry no ambient cookies worth stealing.
 */
export const sameOriginGuard = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const site = c.req.header('Sec-Fetch-Site');
    const origin = c.req.header('Origin');
    if (site && site !== 'same-origin' && site !== 'none') apiError(403, 'auth.errCrossSite');
    if (origin && origin !== new URL(c.req.url).origin) apiError(403, 'auth.errCrossSite');
  }
  await next();
};
