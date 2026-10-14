import { Hono, type Context } from 'hono';
import { clearSession, refreshTokenFrom, setSession, withClearedSession } from '../lib/session';
import { HTTPException } from 'hono/http-exception';
import { and, asc, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { afterResponse, apiError, fieldErrors, pagination, readJson } from '../lib/http';
import { getRegion, isVerifiedIn } from '../lib/region';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { outcomeLimit, rateLimit, takeRate } from '../middleware/rateLimit';
import { turnstileEnabled, verifyTurnstile } from '../lib/turnstile';
import { InvalidTokenError, verifyToken } from '../lib/jwt';
import { books, createDb, listings, type Listing, type User } from '../db';
import { serializeListings } from '../services/listings/serialize';
import type { AccountLinkKind, EmailMessage } from '../queues/types';
import * as ott from '../services/accounts/oneTimeTokens';
import { issueTokens, revokeAllTokensForUser, rotateRefreshToken, verifyAndRevokeRefreshToken } from '../services/accounts/tokens';
import { checkPassword, dummyPasswordCheck, hashPassword, needsRehash, passwordProblems } from '../services/accounts/passwords';
import { emailAlreadyUsed, isPlainEmail, isValidEduEmail, resolveSchoolFromEmail, upsertVerification } from '../services/accounts/edu';
import { GoogleTokenInvalid, GoogleUnavailable, verifyGoogleIdToken } from '../services/accounts/google';
import { EMAIL_LANGUAGE_AUTO, EMAIL_LANGUAGES, resolveLanguage } from '../services/accounts/i18n';
import {
  deleteAccount,
  getUser,
  getUserByEmail,
  isStaffRole,
  nameColumns,
  serializePublicUser,
  serializeUser,
} from '../services/accounts/users';
import { UUID_RE } from '../lib/uuid';
import { nowIso } from '../lib/time';
import { isUniqueViolation } from '../lib/db';

/**
 * /api/v1/auth/*
 */
export const accountRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;

// Rate limits per scope.
/**
 * With Turnstile configured: wrong passwords on one account, per hour,
 * before sign-in asks for a challenge. Below the per-IP sign-in limit
 * (RATES.login, 5/min) on purpose: at the same number, someone retrying at
 * a normal pace hit that limit's 429 first and never saw the challenge.
 */
const LOGIN_CHALLENGE_AFTER_FAILURES = 3;

const RATES = {
  login: '5/min',
  loginAccountFailures: '20/hour',

  register: '10/hour',
  verifyRequest: '3/hour',
  refresh: '10/min',
  passwordChange: '5/min',
  pushDevice: '30/min',
  passwordResetRequest: '3/hour',
  schoolRequest: '5/hour',
  publicProfile: '30/min',
} as const;

const PUSH_TOKEN_MAX_LENGTH = 512;
const NAME_MAX_LENGTH = 150;
const LISTING_STATUSES = ['active', 'reserved', 'sold', 'removed'] as const;

/** The signed-in user's full row (authMiddleware has already checked it is active). */
async function currentUser(c: C): Promise<User> {
  const user = await getUser(c.env, c.get('user')!.id);
  if (!user) apiError(401, 'auth.errNotLoggedIn');
  return user;
}

/** `{last}{first}` trimmed, or "User": the To: name of the verification mails. */
function mailName(user: { firstName: string; lastName: string }): string {
  return `${user.lastName}${user.firstName}`.trim() || 'User';
}

/**
 * Queue one of the account-link emails. Best effort: the token is stored already, and a queue failure
 * must not fail the request. Never logs the link (a bearer credential).
 */
async function sendLinkEmail(c: C, kind: AccountLinkKind, userId: string, to: string, name: string, path: string) {
  const msg: EmailMessage = { type: 'account_link', kind, user_id: userId, to, name, lang: await resolveLanguage(c), path };
  try {
    await c.env.EMAIL_QUEUE.send(msg);
  } catch (e) {
    console.error(`[accounts] could not queue ${kind} email for user ${userId}`, e);
  }
}

function accountDisabled(user: { isActive: number; isBanned: number; deletedAt: string | null }): boolean {
  return !user.isActive || !!user.isBanned || !!user.deletedAt;
}

/** The boolean spellings accepted (true/false, 1/0, yes/no, on/off, t/f, y/n), or undefined for anything else. */
function parseBoolField(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on', 't'].includes(v)) return true;
    if (['false', '0', 'no', 'n', 'off', 'f'].includes(v)) return false;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Registration and verification
// ---------------------------------------------------------------------------

accountRoutes.post('/register/', rateLimit('register', RATES.register), async (c) => {
  const body = await readJson(c.req);
  const fields: Record<string, string[]> = {};

  const rawEmail = body.email;
  let email = '';
  if (rawEmail === undefined || rawEmail === null) fields.email = ['This field is required.'];
  else if (typeof rawEmail !== 'string' || !rawEmail.trim()) fields.email = ['This field may not be blank.'];
  else {
    email = rawEmail.trim().toLowerCase();
    if (!isPlainEmail(email)) fields.email = ['Enter a valid email address.'];
  }

  const names: Record<'first_name' | 'last_name', string> = { first_name: '', last_name: '' };
  for (const key of ['first_name', 'last_name'] as const) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') fields[key] = ['Not a valid string.'];
    else if (v.trim().length > NAME_MAX_LENGTH) fields[key] = [`Ensure this field has no more than ${NAME_MAX_LENGTH} characters.`];
    else names[key] = v.trim();
  }

  const password = body.password;
  if (password === undefined || password === null) fields.password = ['This field is required.'];
  else if (typeof password !== 'string' || !password) fields.password = ['This field may not be blank.'];
  else {
    const problems = passwordProblems(password);
    if (problems.length) fields.password = problems;
  }

  const existing = fields.email ? null : await getUserByEmail(c.env, email);
  const supersede = existing ? await ott.isPendingRegistration(c.env, existing) : false;
  if (existing && !supersede) fields.email = ['acct.errEmailTaken'];
  if (Object.keys(fields).length) apiError(400, 'auth.errValidation', { fields });

  // The password travels with the link, not on the row: only the person who
  // follows the link mailed for *this* registration sets the password the
  // account activates with. Someone registering an address they don't own
  // can neither block its owner nor leave a password on the account.
  const passwordHash = await hashPassword(password as string);
  const { firstName: fn, lastName: ln, name: nm } = nameColumns(names.first_name, names.last_name);
  if (existing && supersede) {
    await ott.voidRegistrationLinks(c.env, existing.id);
    await c.env.DB.prepare(
      'UPDATE users SET name = ?, first_name = ?, last_name = ?, password_hash = NULL, updated_at = ? WHERE id = ? AND is_active = 0',
    )
      .bind(nm, fn, ln, nowIso(), existing.id)
      .run();
    const token = await ott.issue(c.env, ott.REGISTER, existing.id, ott.REGISTER_TTL, { password_hash: passwordHash });
    await sendLinkEmail(
      c,
      'activation',
      existing.id,
      email,
      mailName({ firstName: fn, lastName: ln }),
      `/verify?token=${token}&type=register`,
    );
    return c.json({ code: 'auth.registerSuccess' }, 201);
  }

  // Inactive until the mailed link is followed.
  const id = crypto.randomUUID();
  const now = nowIso();
  const { firstName, lastName, name } = nameColumns(names.first_name, names.last_name);
  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, first_name, last_name, password_hash, role, is_active, is_banned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'user', 0, 0, ?, ?)`,
    )
      .bind(id, email, name, firstName, lastName, now, now)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) apiError(400, 'auth.errValidation', { fields: { email: ['acct.errEmailTaken'] } });
    throw e;
  }

  const token = await ott.issue(c.env, ott.REGISTER, id, ott.REGISTER_TTL, { password_hash: passwordHash });
  await sendLinkEmail(c, 'activation', id, email, mailName({ firstName, lastName }), `/verify?token=${token}&type=register`);
  return c.json({ code: 'auth.registerSuccess' }, 201);
});

/**
 * Follow an activation link. The link alone is not enough: the visitor must
 * also type the password chosen at registration, which is checked against
 * the hash the link carries. Anyone may register a pending address (the
 * owner must be able to register over a squatter), so a link can come from
 * someone else's registration; without this check, an owner who clicked a
 * squatter's link would activate their account with the squatter's
 * password. A wrong password leaves the link usable for another try.
 */
accountRoutes.post('/verify-registration/', rateLimit('activate', RATES.login), async (c) => {
  const { token, password } = await readJson(c.req);
  if (!token) apiError(400, 'auth.errMissingToken');
  const record = await ott.read(c.env, ott.REGISTER, token);
  if (!record) apiError(400, 'auth.errInvalidToken');
  const user = await getUser(c.env, record.userId);
  if (!user) apiError(404, 'auth.errUserNotFound');
  if (user.deletedAt) apiError(400, 'auth.errInvalidToken');
  if (user.isBanned) apiError(403, 'auth.errAccountDisabled');
  const linkHash = record.payload.password_hash;
  if (linkHash) {
    if (typeof password !== 'string' || !password) apiError(400, 'auth.errActivationPasswordRequired');
    if (!(await checkPassword(password, linkHash))) apiError(400, 'auth.errActivationPasswordMismatch');
  }

  if (!(await ott.consume(c.env, record.id))) apiError(400, 'auth.errInvalidToken');
  try {
    if (!user.isActive) {
      await c.env.DB.prepare(
        'UPDATE users SET is_active = 1, password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ? AND is_active = 0 AND deleted_at IS NULL',
      )
        .bind(record.payload.password_hash ?? null, nowIso(), user.id)
        .run();
      await ott.voidRegistrationLinks(c.env, user.id);
    }
    // A token-store outage (503) gives the link back, so the visitor can open it again.
    setSession(c, await issueTokens(c.env, user.id));
    return c.json({ code: 'auth.loginSuccess', user_id: user.id });
  } catch (e) {
    await ott.unconsume(c.env, record.id).catch(() => undefined);
    throw e;
  }
});

accountRoutes.post('/verify/request/', authMiddleware(), rateLimit('verify-request', RATES.verifyRequest), async (c) => {
  const body = await readJson(c.req);
  const raw = body.edu_email;
  if (!raw || typeof raw !== 'string') apiError(400, 'acct.errEduEmail');
  // One plain address: the campus check reads only the domain after the last @.
  const eduEmail = raw.trim().toLowerCase();
  if (!isPlainEmail(eduEmail) || !(await isValidEduEmail(c.env, eduEmail))) apiError(400, 'acct.errEduEmail');
  const resolved = await resolveSchoolFromEmail(c.env, eduEmail);
  if (!resolved) apiError(400, 'acct.errSchoolNotSupported');
  const user = await currentUser(c);
  if (await emailAlreadyUsed(c.env, eduEmail, user.id)) apiError(400, 'acct.errEmailTaken');

  const token = await ott.issue(c.env, ott.EDU_VERIFY, user.id, ott.EDU_VERIFY_TTL, { edu_email: eduEmail });
  await sendLinkEmail(c, 'eduVerification', user.id, eduEmail, mailName(user), `/verify?token=${token}&type=edu`);
  return c.json({ code: 'acct.sentVerification' });
});

accountRoutes.post('/verify/', async (c) => {
  const { token } = await readJson(c.req);
  if (!token) apiError(400, 'auth.errMissingToken');
  const record = await ott.read(c.env, ott.EDU_VERIFY, token);
  if (!record) apiError(400, 'auth.errInvalidToken');
  const user = await getUser(c.env, record.userId);
  if (!user || user.deletedAt) apiError(404, 'auth.errUserNotFound');

  const eduEmail = (record.payload.edu_email ?? '').toLowerCase();
  const resolved = await resolveSchoolFromEmail(c.env, eduEmail);
  // Re-checked now, not only when the link was sent: a day is long enough
  // for another account to have taken the address.
  if (resolved && (await emailAlreadyUsed(c.env, eduEmail, user.id))) {
    await ott.consume(c.env, record.id);
    apiError(400, 'acct.errEmailTaken');
  }
  if (!(await ott.consume(c.env, record.id))) apiError(400, 'auth.errInvalidToken');
  if (resolved) {
    let ok: boolean;
    try {
      ok = await upsertVerification(c.env, user.id, resolved.regionCode, resolved.school.id, eduEmail);
    } catch (e) {
      await ott.unconsume(c.env, record.id).catch(() => undefined);
      throw e;
    }
    if (!ok) apiError(400, 'acct.errEmailTaken');
  }
  return c.json({ code: 'acct.verifySuccess' });
});

accountRoutes.post('/verify/auto/', authMiddleware(), rateLimit('verify-request', RATES.verifyRequest), async (c) => {
  const user = await currentUser(c);
  const email = user.email.trim().toLowerCase();
  if (!(await isValidEduEmail(c.env, email))) apiError(400, 'acct.errEduEmail');
  const resolved = await resolveSchoolFromEmail(c.env, email);
  if (!resolved) apiError(400, 'acct.errSchoolNotSupported');
  if (await isVerifiedIn(c.env, user.id, resolved.regionCode)) return c.json({ code: 'acct.verifySuccess' });
  if (await emailAlreadyUsed(c.env, email, user.id)) apiError(400, 'acct.errEmailTaken');
  if (!(await upsertVerification(c.env, user.id, resolved.regionCode, resolved.school.id, email))) {
    apiError(400, 'acct.errEmailTaken');
  }
  return c.json({ code: 'acct.verifySuccess' });
});

accountRoutes.post('/verify/unbind/', authMiddleware(), async (c) => {
  const region = await getRegion(c);
  if (!region) apiError(400, 'sys.errUnknownRegion');
  const res = await c.env.DB.prepare(
    'UPDATE region_verifications SET is_active = 0 WHERE user_id = ? AND region_code = ? AND is_active = 1',
  )
    .bind(c.get('user')!.id, region.code)
    .run();
  if (!res.meta.changes) apiError(400, 'acct.errNotVerified');
  return c.json({ code: 'acct.unbindSuccess' });
});

function validWebsite(value: string): boolean {
  if (value.length > 500 || !/^https?:\/\//i.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname.includes('.') || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

interface SchoolRequestRow {
  id: number;
  school_name: string;
  school_website: string;
  edu_email: string;
  status: string;
  created_at: string;
}

function pendingSchoolRequest(c: C, userId: string, region: string, name: string) {
  return c.env.DB.prepare(
    `SELECT id, school_name, school_website, edu_email, status, created_at FROM school_requests
     WHERE user_id = ? AND region_code = ? AND lower(school_name) = lower(?) AND status = 'pending' LIMIT 1`,
  )
    .bind(userId, region, name)
    .first<SchoolRequestRow>();
}

accountRoutes.post('/school-requests/', authMiddleware(), rateLimit('school-request', RATES.schoolRequest), async (c) => {
  const region = await getRegion(c);
  if (!region) apiError(400, 'sys.errUnknownRegion');
  const body = await readJson(c.req);
  const fields: Record<string, string[]> = {};

  const name = typeof body.school_name === 'string' ? body.school_name.trim() : '';
  if (name.length < 2 || name.length > 255) fields.school_name = ['acct.errSchoolRequestName'];
  const website = typeof body.school_website === 'string' ? body.school_website.trim() : '';
  if (!validWebsite(website)) fields.school_website = ['acct.errSchoolRequestWebsite'];
  let eduEmail = '';
  if (body.edu_email !== undefined && body.edu_email !== null) {
    if (typeof body.edu_email !== 'string') fields.edu_email = ['acct.errSchoolRequestEmail'];
    else {
      eduEmail = body.edu_email.trim().toLowerCase();
      if (eduEmail && !isPlainEmail(eduEmail)) fields.edu_email = ['acct.errSchoolRequestEmail'];
    }
  }
  if (Object.keys(fields).length) fieldErrors(fields);

  const userId = c.get('user')!.id;
  // A repeat of a pending request answers 200 with that row (201 = new row).
  const existing = await pendingSchoolRequest(c, userId, region.code, name);
  if (existing) return c.json(existing, 200);
  const now = nowIso();
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO school_requests (region_code, user_id, school_name, school_website, edu_email, status, admin_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', '', ?, ?)
       RETURNING id, school_name, school_website, edu_email, status, created_at`,
    )
      .bind(region.code, userId, name, website, eduEmail, now, now)
      .first<SchoolRequestRow>();
    return c.json(row, 201);
  } catch (e) {
    // Lost the race to an identical submit; the unique index kept it to one row.
    const raced = isUniqueViolation(e) ? await pendingSchoolRequest(c, userId, region.code, name) : null;
    if (!raced) throw e;
    return c.json(raced, 200);
  }
});

// ---------------------------------------------------------------------------
// Sign-in, tokens, sign-out
// ---------------------------------------------------------------------------

accountRoutes.post('/token/', rateLimit('login', RATES.login), async (c) => {
  const { email, password, cf_turnstile_response: challenge } = await readJson(c.req);
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    apiError(400, 'auth.errValidation');
  }
  // Per account too, not only per IP: a password guessed from many IPs.
  // Only wrong passwords count, so the owner's own sign-ins never use it up.
  const failures = outcomeLimit(c, 'login_account_failures', RATES.loginAccountFailures, email.trim().toLowerCase());
  if (turnstileEnabled(c.env)) {
    // With Turnstile, a few failures ask for a human check instead of
    // locking the account: a stranger's guesses can no longer keep the
    // owner out, and a guessing script has to solve every challenge.
    if (await failures.reached(LOGIN_CHALLENGE_AFTER_FAILURES)) {
      // The site key rides along, so the app needs no build-time setting to render the widget.
      const site = { site_key: c.env.TURNSTILE_SITE_KEY };
      if (!challenge) apiError(403, 'auth.errChallengeRequired', site);
      if (!(await verifyTurnstile(c.env, challenge, c.req.header('CF-Connecting-IP')))) apiError(403, 'auth.errChallengeFailed', site);
    }
  } else {
    await failures.assertUnder();
  }
  const invalid = async (): Promise<never> => {
    await failures.count();
    apiError(401, 'auth.errInvalidCredentials');
  };
  const user = await getUserByEmail(c.env, email);
  if (!user) {
    // Same hashing cost as a real account, so timing does not reveal which addresses exist.
    await dummyPasswordCheck(password);
    return invalid();
  }
  if (!user.passwordHash && (await ott.isPendingRegistration(c.env, user))) {
    // Registered, not yet activated: the password lives on the mailed link.
    // Whoever knows it gets the "not active yet" answer; anyone else a
    // plain credentials error.
    for (const hash of await ott.pendingRegistrationHashes(c.env, user.id)) {
      if (await checkPassword(password, hash)) apiError(403, 'auth.errAccountDisabled');
    }
    return invalid();
  }
  if (!(await checkPassword(password, user.passwordHash))) return invalid();
  if (accountDisabled(user)) apiError(403, 'auth.errAccountDisabled');
  // Hashed under older parameters: replace it now, while the password is known.
  if (needsRehash(user.passwordHash!)) {
    await afterResponse(
      c,
      hashPassword(password).then((h) =>
        c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').bind(h, user.id, user.passwordHash).run(),
      ),
    );
  }

  setSession(c, await issueTokens(c.env, user.id));
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  return c.json({ code: 'auth.loginSuccess', user_id: user.id });
});

accountRoutes.post('/refresh/', rateLimit('refresh_token', RATES.refresh), async (c) => {
  const refresh = refreshTokenFrom(c, await readJson(c.req));
  if (!refresh) apiError(401, 'auth.errInvalidToken');
  try {
    setSession(c, await rotateRefreshToken(c.env, refresh));
  } catch (e) {
    // A refused refresh token (401/403) ends the browser session too; a 503
    // (token store down) is transient and keeps the cookies.
    if (e instanceof HTTPException && (e.status === 401 || e.status === 403)) return withClearedSession(e.getResponse());
    throw e;
  }
  return c.json({ code: 'auth.refreshed' });
});

accountRoutes.post('/google/', rateLimit('login', RATES.login), async (c) => {
  const { credential } = await readJson(c.req);
  if (!credential || typeof credential !== 'string') apiError(400, 'auth.errMissingCredential');
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('[accounts] Google sign-in is not configured (GOOGLE_CLIENT_ID)');
    apiError(500, 'auth.errProviderNotConfigured');
  }

  let claims;
  try {
    claims = await verifyGoogleIdToken(credential, clientId);
  } catch (e) {
    if (e instanceof GoogleTokenInvalid) apiError(401, 'auth.errInvalidToken');
    if (e instanceof GoogleUnavailable) {
      console.error("[accounts] could not reach Google's certificate endpoint", e);
      apiError(503, 'auth.errProviderNotConfigured');
    }
    throw e;
  }

  if (!claims.email) apiError(400, 'auth.errNoEmail');
  // An unverified Google address must never sign into the account that owns it here.
  const verified = claims.email_verified;
  if (verified !== true && String(verified).toLowerCase() !== 'true') apiError(403, 'auth.errEmailNotVerified');

  const email = claims.email.trim().toLowerCase();
  const avatarUrl = typeof claims.picture === 'string' ? claims.picture : '';
  let user = await getUserByEmail(c.env, email);
  if (!user) {
    const id = crypto.randomUUID();
    const now = nowIso();
    const cols = nameColumns(String(claims.given_name ?? ''), String(claims.family_name ?? ''));
    try {
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, name, first_name, last_name, password_hash, avatar_url, role, is_active, is_banned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'user', 1, 0, ?, ?)`,
      )
        .bind(id, email, cols.name, cols.firstName, cols.lastName, avatarUrl, now, now)
        .run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    user = await getUserByEmail(c.env, email);
    if (!user) throw new Error('google sign-in: user row missing after insert');
  } else if (avatarUrl && user.avatarUrl !== avatarUrl) {
    await c.env.DB.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?').bind(avatarUrl, nowIso(), user.id).run();
  }

  // The address may have been recycled to a different Google account (e.g. a
  // reassigned Workspace mailbox): an account linked to one Google identity
  // never signs in with another.
  if (user.googleId && user.googleId !== claims.sub) apiError(403, 'auth.errAccountDisabled');

  // A row someone registered for this address but never activated proves
  // nothing; the verified Google address does. Claim it: drop any password,
  // void its links, activate. (An admin-disabled or used account is not
  // pending and stays disabled below.)
  if (await ott.isPendingRegistration(c.env, user)) {
    await ott.voidRegistrationLinks(c.env, user.id);
    await c.env.DB.prepare('UPDATE users SET is_active = 1, password_hash = NULL, updated_at = ? WHERE id = ? AND is_active = 0')
      .bind(nowIso(), user.id)
      .run();
    user = (await getUser(c.env, user.id)) ?? user;
  }

  // No reactivation: Google sign-in does not get past a disabled account.
  if (accountDisabled(user)) apiError(403, 'auth.errAccountDisabled');

  // A Google address at a supported campus is a proven campus address.
  if (await isValidEduEmail(c.env, email)) {
    const resolved = await resolveSchoolFromEmail(c.env, email);
    if (resolved && !(await emailAlreadyUsed(c.env, email, user.id))) {
      await upsertVerification(c.env, user.id, resolved.regionCode, resolved.school.id, email);
    }
  }

  // Link the Google account. One per user here; a
  // `sub` already linked elsewhere is left where it is.
  if (!user.googleId) {
    try {
      await c.env.DB.prepare('UPDATE users SET google_id = ? WHERE id = ? AND google_id IS NULL').bind(claims.sub, user.id).run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      console.warn(`[accounts] Google account already linked to another user; not linking to ${user.id}`);
    }
  }

  setSession(c, await issueTokens(c.env, user.id));
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  const region = await getRegion(c);
  const isVerified = region ? await isVerifiedIn(c.env, user.id, region.code) : false;
  return c.json({ code: 'auth.loginSuccess', user_id: user.id, user: { is_verified: isVerified } });
});

accountRoutes.get('/config/', (c) => {
  // Firebase web config: public values, but only offered once push is fully set up.
  const env = c.env as AppEnv['Bindings'] & Record<string, string | undefined>;
  const web = {
    api_key: env.FCM_WEB_API_KEY ?? '',
    project_id: env.FIREBASE_PROJECT_ID ?? '',
    app_id: env.FCM_WEB_APP_ID ?? '',
    messaging_sender_id: env.FCM_MESSAGING_SENDER_ID ?? '',
    vapid_key: env.FCM_VAPID_KEY ?? '',
  };
  const fcmConfigured = !!env.FIREBASE_SERVICE_ACCOUNT_JSON && !!env.FIREBASE_PROJECT_ID;
  const complete = fcmConfigured && web.api_key && web.app_id && web.messaging_sender_id && web.vapid_key;
  return c.json({ google_client_id: c.env.GOOGLE_CLIENT_ID ?? '', fcm: complete ? web : null });
});

accountRoutes.post('/logout/', optionalAuthMiddleware(), async (c) => {
  // Best effort, and never refused: the cookies are always cleared, and the
  // refresh token is revoked whenever it still verifies — even when the
  // access token has already expired.
  const body = await readJson(c.req);
  const refresh = refreshTokenFrom(c, body);
  clearSession(c);
  let userId = c.get('user')?.id ?? null;
  let jti: string | null = null;
  if (refresh) {
    try {
      const claims = await verifyToken('refresh', refresh, c.env);
      userId ??= claims.user_id;
      if (claims.user_id === userId) jti = claims.jti;
    } catch (e) {
      if (!(e instanceof InvalidTokenError)) throw e; // a bad token: signing out anyway
    }
  }
  if (userId && body.all_devices) await revokeAllTokensForUser(c.env, userId);
  else if (userId && jti) await verifyAndRevokeRefreshToken(c.env, jti, userId);
  return c.json({ code: 'auth.logoutSuccess' });
});

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

accountRoutes.post('/password/', authMiddleware(), rateLimit('password_change', RATES.passwordChange), async (c) => {
  const user = await currentUser(c);
  const { old_password: oldPassword, new_password: newPassword } = await readJson(c.req);
  if (!newPassword || typeof newPassword !== 'string') apiError(400, 'auth.errValidation');
  if (user.passwordHash) {
    if (!oldPassword || typeof oldPassword !== 'string') apiError(400, 'auth.errValidation');
    if (!(await checkPassword(oldPassword, user.passwordHash))) fieldErrors({ old_password: ['Incorrect password.'] });
  }
  const problems = passwordProblems(newPassword, user);
  if (problems.length) apiError(400, 'auth.errValidation', { fields: problems });

  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(newPassword), nowIso(), user.id)
    .run();
  // Every other session ends; this device gets a fresh pair.
  await revokeAllTokensForUser(c.env, user.id);
  setSession(c, await issueTokens(c.env, user.id));
  return c.json({ code: 'acct.passwordUpdated' });
});

accountRoutes.post('/password/remove/', authMiddleware(), rateLimit('password_change', RATES.passwordChange), async (c) => {
  const user = await currentUser(c);
  const { password } = await readJson(c.req);
  if (!password || typeof password !== 'string') apiError(400, 'auth.errValidation');
  if (!user.googleId) apiError(400, 'auth.errNoGoogleLinked');
  if (isStaffRole(user.role)) apiError(400, 'auth.errStaffCannotRemovePassword');
  if (!user.passwordHash) apiError(400, 'auth.errNoUsablePassword');
  if (!(await checkPassword(password, user.passwordHash))) apiError(400, 'auth.errInvalidPassword');
  await c.env.DB.prepare('UPDATE users SET password_hash = NULL, updated_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  return c.json({ code: 'acct.passwordRemoved' });
});

accountRoutes.post('/password/reset/request/', rateLimit('password-reset-request', RATES.passwordResetRequest), async (c) => {
  const { email: raw } = await readJson(c.req);
  if (!raw || typeof raw !== 'string') apiError(400, 'auth.errValidation');
  const email = raw.trim();
  const sent = { code: 'acct.passwordResetSent' };
  // Per address as well as per caller, so one mailbox cannot be flooded
  // from many addresses. Checked for every address, known or not, so the
  // limit says nothing about which ones exist. Over the limit, the request
  // gets the usual answer and no email: a stranger hammering someone's
  // address never shows that person an error.
  if (!(await takeRate(c, 'password-reset-request-email', RATES.passwordResetRequest, `email:${email.toLowerCase()}`))) {
    return c.json(sent);
  }

  const user = await getUserByEmail(c.env, email);
  // The same answer whatever happens: no way to probe which addresses exist.
  if (!user || user.googleId || accountDisabled(user)) return c.json(sent);

  const token = await ott.issue(c.env, ott.PASSWORD_RESET, user.id, ott.PASSWORD_RESET_TTL);
  await sendLinkEmail(c, 'passwordReset', user.id, user.email, '', `/forgot-password?token=${token}`);
  return c.json(sent);
});

accountRoutes.post('/password/reset/confirm/', async (c) => {
  const { token, new_password: newPassword } = await readJson(c.req);
  if (!token) apiError(400, 'auth.errMissingToken');
  if (!newPassword || typeof newPassword !== 'string') apiError(400, 'auth.errValidation');
  const record = await ott.read(c.env, ott.PASSWORD_RESET, token);
  if (!record) apiError(400, 'auth.errInvalidToken');
  const user = await getUser(c.env, record.userId);
  if (!user) apiError(404, 'auth.errUserNotFound');
  if (accountDisabled(user)) {
    await ott.consume(c.env, record.id);
    apiError(403, 'auth.errAccountDisabled');
  }
  // Validated before consuming: a rejected password leaves the link usable.
  const problems = passwordProblems(newPassword, user);
  if (problems.length) apiError(400, 'auth.errValidation', { fields: problems });
  if (!(await ott.consume(c.env, record.id))) apiError(400, 'auth.errInvalidToken');

  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(newPassword), nowIso(), user.id)
    .run();
  // Any existing session may be the compromised credential this reset fixes.
  await revokeAllTokensForUser(c.env, user.id);
  return c.json({ code: 'acct.passwordResetSuccess' });
});

// ---------------------------------------------------------------------------
// Email change
// ---------------------------------------------------------------------------

accountRoutes.post('/email/change/confirm/', rateLimit('password_change', RATES.passwordChange), async (c) => {
  const { token } = await readJson(c.req);
  if (!token) apiError(400, 'auth.errMissingToken');
  const record = await ott.read(c.env, ott.EMAIL_CHANGE, token);
  if (!record) apiError(400, 'acct.errEmailChangeTokenInvalid');
  const user = await getUser(c.env, record.userId);
  if (!user) apiError(404, 'auth.errUserNotFound');
  if (!(await ott.consume(c.env, record.id))) apiError(400, 'acct.errEmailChangeTokenInvalid');
  if (accountDisabled(user)) apiError(403, 'auth.errAccountDisabled');

  const newEmail = (record.payload.email ?? '').trim().toLowerCase();
  if (!newEmail) apiError(400, 'acct.errEmailChangeTokenInvalid');
  // Re-checked at confirm time: an hour is long enough for the address to be
  // taken, or for its domain to become a supported campus.
  const taken = await c.env.DB.prepare('SELECT 1 AS hit FROM users WHERE lower(email) = ? AND id != ? LIMIT 1')
    .bind(newEmail, user.id)
    .first();
  if (taken) {
    await ott.cancelEmailChange(c.env, user.id);
    apiError(400, 'acct.errEmailTaken');
  }
  if (await isValidEduEmail(c.env, newEmail)) {
    await ott.cancelEmailChange(c.env, user.id);
    apiError(400, 'acct.errEduEmailChangeNotAllowed');
  }
  try {
    await c.env.DB.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').bind(newEmail, nowIso(), user.id).run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    await ott.cancelEmailChange(c.env, user.id);
    apiError(400, 'acct.errEmailTaken');
  }
  await ott.cancelEmailChange(c.env, user.id);
  return c.json({ code: 'acct.emailChanged' });
});

accountRoutes.post('/email/change/cancel/', authMiddleware(), async (c) => {
  await ott.cancelEmailChange(c.env, c.get('user')!.id);
  return c.json({ code: 'acct.emailChangeCancelled' });
});

// ---------------------------------------------------------------------------
// The signed-in user's account
// ---------------------------------------------------------------------------

const LISTING_SORTS: Record<string, SQL[]> = {
  newest: [desc(listings.createdAt)],
  oldest: [asc(listings.createdAt)],
  price_asc: [asc(listings.price), desc(listings.createdAt)],
  price_desc: [desc(listings.price), desc(listings.createdAt)],
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

async function myListingsBlock(c: C, userId: string, regionCode: string | null, lang: string) {
  const db = createDb(c.env.DB);
  const counts: Record<string, number> = Object.fromEntries(LISTING_STATUSES.map((s) => [s, 0]));
  const page = pagination(c.req.url);
  if (!regionCode) {
    return { counts: { ...counts, all: 0 }, page: page.wrap([], 0) };
  }

  const countRows = await db
    .select({ status: listings.status, n: sql<number>`count(*)` })
    .from(listings)
    .where(and(eq(listings.sellerId, userId), eq(listings.regionCode, regionCode)))
    .groupBy(listings.status);
  let all = 0;
  for (const r of countRows) {
    counts[r.status] = Number(r.n);
    all += Number(r.n);
  }

  const conditions: SQL[] = [eq(listings.sellerId, userId), eq(listings.regionCode, regionCode)];
  const status = (c.req.query('status') ?? '').trim();
  if ((LISTING_STATUSES as readonly string[]).includes(status)) conditions.push(eq(listings.status, status as Listing['status']));
  const q = (c.req.query('q') ?? '').trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    const likeEsc = (col: Parameters<typeof like>[0]) => sql`${col} LIKE ${pattern} ESCAPE '\\'`;
    conditions.push(
      or(
        likeEsc(books.title),
        likeEsc(books.authors),
        likeEsc(books.isbn13),
        likeEsc(listings.courseName),
        likeEsc(listings.professorName),
      )!,
    );
  }
  const where = and(...conditions);
  const [{ n: total }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(listings)
    .innerJoin(books, eq(books.id, listings.bookId))
    .where(where);
  if (page.page > 1 && page.offset >= Number(total)) {
    // A page past the end is a 404.
    return { counts: { ...counts, all }, invalidPage: true as const };
  }
  const rows = await db
    .select({ listing: listings })
    .from(listings)
    .innerJoin(books, eq(books.id, listings.bookId))
    .where(where)
    .orderBy(...(LISTING_SORTS[c.req.query('sort') ?? ''] ?? LISTING_SORTS.newest))
    .limit(page.limit)
    .offset(page.offset);
  const results = await serializeListings(
    c.env,
    rows.map((r) => r.listing),
    { viewerId: userId, lang },
  );
  return { counts: { ...counts, all }, page: page.wrap(results, Number(total)) };
}

async function mySubscriptions(c: C, userId: string, regionCode: string | null) {
  if (!regionCode) return [];
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.book_id, s.created_at, b.title, b.isbn13, b.cover_url,
       (SELECT COUNT(DISTINCT l.id) FROM listings l
         WHERE l.book_id = s.book_id AND l.status = 'active' AND l.created_at > s.created_at) AS new_count
     FROM subscriptions s JOIN books b ON b.id = s.book_id
     WHERE s.user_id = ? AND s.region_code = ?
     ORDER BY s.created_at DESC`,
  )
    .bind(userId, regionCode)
    .all<{
      id: string;
      book_id: string;
      created_at: string;
      title: string;
      isbn13: string | null;
      cover_url: string | null;
      new_count: number;
    }>();
  return results.map((s) => ({
    id: s.id,
    book: s.book_id,
    bookTitle: s.title,
    isbn: s.isbn13,
    bookCoverUrl: s.cover_url,
    newListingsCount: Number(s.new_count),
    created_at: s.created_at,
  }));
}

accountRoutes.get('/me/', authMiddleware(), async (c) => {
  const user = await currentUser(c);
  const [data, region, lang] = await Promise.all([serializeUser(c, user), getRegion(c), resolveLanguage(c)]);
  const regionCode = region?.code ?? null;
  const listingsBlock = await myListingsBlock(c, user.id, regionCode, lang);
  if ('invalidPage' in listingsBlock) return c.json({ detail: 'Invalid page.' }, 404);
  const [pendingEmail, subs] = await Promise.all([ott.pendingEmailChange(c.env, user.id), mySubscriptions(c, user.id, regionCode)]);
  return c.json({
    ...data,
    myListingCounts: listingsBlock.counts,
    myListings: listingsBlock.page,
    pending_email: pendingEmail,
    mySubscriptions: subs,
  });
});

/** An ISO 8601 date-time, or null when it does not parse. */
function parseDateTime(value: string): string | null {
  if (!/^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{1,2}/.test(value)) return null;
  const d = new Date(value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

accountRoutes.patch('/me/', authMiddleware(), async (c) => {
  const user = await currentUser(c);
  const body = await readJson(c.req);
  const { first_name: firstName, last_name: lastName, email, show_avatar: showAvatar } = body;

  if (showAvatar !== undefined && showAvatar !== null && typeof showAvatar !== 'boolean') fieldErrors({ show_avatar: ['Invalid value.'] });
  for (const [key, value] of [
    ['first_name', firstName],
    ['last_name', lastName],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') fieldErrors({ [key]: ['Invalid value.'] });
    if (value.trim().length > NAME_MAX_LENGTH)
      fieldErrors({ [key]: [`Ensure this field has no more than ${NAME_MAX_LENGTH} characters.`] });
  }
  for (const key of ['last_seen_bought_orders_at', 'last_seen_sold_orders_at'] as const) {
    const v = body[key];
    if (v !== undefined && v !== null && typeof v !== 'string') fieldErrors({ [key]: ['Invalid value.'] });
  }
  if (email !== undefined && email !== null && typeof email !== 'string') fieldErrors({ email: ['Invalid value.'] });

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };
  if (typeof showAvatar === 'boolean' && showAvatar !== !!user.showAvatar) set('show_avatar', showAvatar ? 1 : 0);
  if (typeof firstName === 'string' || typeof lastName === 'string') {
    const cols = nameColumns(
      typeof firstName === 'string' ? firstName.trim() : user.firstName,
      typeof lastName === 'string' ? lastName.trim() : user.lastName,
    );
    set('first_name', cols.firstName);
    set('last_name', cols.lastName);
    set('name', cols.name);
  }
  const saveFields = async () => {
    if (!sets.length) return;
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...binds, nowIso(), user.id)
      .run();
    sets.length = 0;
    binds.length = 0;
  };

  if (typeof email === 'string') {
    const newEmail = email.trim().toLowerCase();
    if (newEmail !== user.email) {
      if (user.googleId) fieldErrors({ email: ['You cannot change the email of a Google-linked account.'] });
      if (!isPlainEmail(newEmail)) fieldErrors({ email: ['Enter a valid email address.'] });
      const taken = await c.env.DB.prepare('SELECT 1 AS hit FROM users WHERE lower(email) = ? AND id != ? LIMIT 1')
        .bind(newEmail, user.id)
        .first();
      if (taken) fieldErrors({ email: ['Email is already in use.'] });
      // A campus address as the sign-in email is what auto-verify trusts; it
      // is only ever set by registration or Google, never edited in.
      if (await isValidEduEmail(c.env, newEmail)) apiError(400, 'acct.errEduEmailChangeNotAllowed');
      // Not applied here: only once the link mailed to the new address is followed.
      // The other fields are saved first, so an error there leaves no live link.
      await saveFields();
      const token = await ott.issueEmailChange(c.env, user.id, newEmail);
      await sendLinkEmail(c, 'emailChange', user.id, newEmail, '', `/account/settings?email_change_token=${token}`);
      return c.json({ code: 'acct.emailChangePending', pending_email: newEmail });
    }
  }

  for (const [key, column] of [
    ['last_seen_bought_orders_at', 'last_seen_bought_orders_at'],
    ['last_seen_sold_orders_at', 'last_seen_sold_orders_at'],
  ] as const) {
    const v = body[key];
    if (typeof v === 'string') set(column, v ? parseDateTime(v) : null);
    else if (v === null) set(column, null);
  }
  await saveFields();
  const fresh = await currentUser(c);
  return c.json(await serializeUser(c, fresh));
});

accountRoutes.delete('/me/', authMiddleware(), async (c) => {
  // Anonymizes rather than removes. (A 204 cannot carry a body.)
  await deleteAccount(c.env, c.get('user')!.id);
  clearSession(c);
  return c.body(null, 204);
});

function notificationSettings(user: User) {
  return {
    new_message_email: !!user.notifyNewMessageEmail,
    push: !!user.notifyPush,
    email_language: user.emailLanguage,
    site_language: user.siteLanguage,
  };
}

accountRoutes.get('/me/notifications/', authMiddleware(), async (c) => {
  return c.json(notificationSettings(await currentUser(c)));
});

accountRoutes.patch('/me/notifications/', authMiddleware(), async (c) => {
  const user = await currentUser(c);
  const body = await readJson(c.req);
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [key, column] of [
    ['new_message_email', 'notify_new_message_email'],
    ['push', 'notify_push'],
  ] as const) {
    if (!(key in body)) continue;
    const v = parseBoolField(body[key]);
    if (v === undefined) apiError(400, 'auth.errValidation');
    sets.push(`${column} = ?`);
    binds.push(v ? 1 : 0);
  }
  if ('email_language' in body) {
    const v = body.email_language;
    if (typeof v !== 'string' || ![EMAIL_LANGUAGE_AUTO, ...EMAIL_LANGUAGES].includes(v)) apiError(400, 'auth.errValidation');
    sets.push('email_language = ?');
    binds.push(v);
  }
  // site_language is read-only here (its own endpoint writes it); anything else is ignored.
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...binds, nowIso(), user.id)
      .run();
  }
  return c.json(notificationSettings(await currentUser(c)));
});

function pushToken(body: Record<string, unknown>): string | null {
  const token = body.token;
  if (typeof token !== 'string' || !token.trim() || token.length > PUSH_TOKEN_MAX_LENGTH) return null;
  return token.trim();
}

accountRoutes.post('/me/push-devices/', authMiddleware(), rateLimit('push_device', RATES.pushDevice), async (c) => {
  const token = pushToken(await readJson(c.req));
  if (!token) apiError(400, 'auth.errValidation');
  const now = nowIso();
  // Keyed on the token alone: registering one another account holds moves it here.
  await c.env.DB.prepare(
    `INSERT INTO push_devices (user_id, token, platform, is_active, created_at, updated_at)
     VALUES (?, ?, 'web', 1, ?, ?)
     ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, is_active = 1, updated_at = excluded.updated_at`,
  )
    .bind(c.get('user')!.id, token, now, now)
    .run();
  return c.body(null, 204);
});

accountRoutes.delete('/me/push-devices/', authMiddleware(), rateLimit('push_device', RATES.pushDevice), async (c) => {
  const token = pushToken(await readJson(c.req));
  if (!token) apiError(400, 'auth.errValidation');
  // Only ever the caller's own device.
  await c.env.DB.prepare('DELETE FROM push_devices WHERE user_id = ? AND token = ?').bind(c.get('user')!.id, token).run();
  return c.body(null, 204);
});

accountRoutes.put('/me/site-language/', authMiddleware(), async (c) => {
  const { language } = await readJson(c.req);
  if (typeof language !== 'string' || !EMAIL_LANGUAGES.includes(language)) apiError(400, 'auth.errValidation');
  await c.env.DB.prepare('UPDATE users SET site_language = ? WHERE id = ? AND site_language != ?')
    .bind(language, c.get('user')!.id, language)
    .run();
  return c.body(null, 204);
});

accountRoutes.put('/me/site-region/', authMiddleware(), async (c) => {
  const { region } = await readJson(c.req);
  const userId = c.get('user')!.id;
  if (typeof region !== 'string' || !region || !(await isVerifiedIn(c.env, userId, region.toUpperCase()))) {
    apiError(400, 'auth.errValidation');
  }
  const code = region.toUpperCase();
  await c.env.DB.prepare('UPDATE users SET site_region = ? WHERE id = ? AND site_region != ?').bind(code, userId, code).run();
  return c.body(null, 204);
});

accountRoutes.get('/users/:id/', optionalAuthMiddleware(), rateLimit('public_profile', RATES.publicProfile), async (c) => {
  const id = c.req.param('id');
  const user = UUID_RE.test(id) ? await getUser(c.env, id) : null;
  if (!user) apiError(404, 'auth.errUserNotFound');
  return c.json(await serializePublicUser(c, user));
});
