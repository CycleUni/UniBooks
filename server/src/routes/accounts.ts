import { Hono, type Context } from 'hono';
import { clearSession, refreshTokenFrom, setSession, withClearedSession } from '../lib/session';
import { HTTPException } from 'hono/http-exception';
import { and, asc, desc, eq, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../env';
import { afterResponse, apiError, fieldErrors, pagination, readJson } from '../lib/http';
import { getRegion, isVerifiedIn } from '../lib/region';
import { authMiddleware, optionalAuthMiddleware, requireRecentSignIn } from '../middleware/auth';
import { outcomeLimit, rateLimit, takeRate } from '../middleware/rateLimit';
import { turnstileEnabled, verifyTurnstile } from '../lib/turnstile';
import { InvalidTokenError, verifyToken } from '../lib/jwt';
import {
  books,
  createDb,
  listings,
  pushDevices,
  regionVerifications,
  schoolRequests,
  subscriptions,
  users,
  type InsertUser,
  type Listing,
  type User,
} from '../db';
import { serializeListings } from '../services/listings/serialize';
import type { AccountLinkKind, EmailMessage } from '../queues/types';
import * as ott from '../services/accounts/oneTimeTokens';
import { issueTokens, revokeAllTokensForUser, rotateRefreshToken, verifyAndRevokeRefreshToken } from '../services/accounts/tokens';
import { checkPassword, dummyPasswordCheck, hashPassword, needsRehash, passwordProblems } from '../services/accounts/passwords';
import { emailAlreadyUsed, isPlainEmail, isValidEduEmail, resolveSchoolFromEmail, upsertVerification } from '../services/accounts/edu';
import { GoogleTokenInvalid, GoogleUnavailable, verifyGoogleIdToken } from '../services/accounts/google';
import { EMAIL_LANGUAGE_AUTO, EMAIL_LANGUAGES, resolveLanguage } from '../services/accounts/i18n';
import {
  accountDisabled,
  deleteAccount,
  getUser,
  getUserByEmail,
  isStaffRole,
  nameColumns,
  serializePublicUser,
  serializeUser,
  touchLastLogin,
} from '../services/accounts/users';
import {
  beginSecondFactor,
  countUserPasskeys,
  deleteUserPasskey,
  getPasskeyLoginOptions,
  getPasskeyRegistrationOptions,
  listUserPasskeys,
  renameUserPasskey,
  setPasskeyTwoStep,
  verifyPasskeyLogin,
  verifyPasskeyRegistration,
  verifySecondFactor,
} from '../services/accounts/passkeys';
import { UUID_RE } from '../lib/uuid';
import { nowIso } from '../lib/time';
import { isUniqueViolation } from '../lib/db';

/**
 * /api/v1/auth/*
 */
export const accountRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;

/** Whether an account other than `userId` signs in with `email` (already lower-cased). */
async function emailTakenByOther(c: C, email: string, userId: string): Promise<boolean> {
  const [row] = await createDb(c.env.DB)
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, ne(users.id, userId)))
    .limit(1);
  return !!row;
}

// Rate limits per scope. Unauthenticated ones are keyed by IP, and a campus
// puts hundreds of students behind one address: those stay loose, since
// Turnstile already makes each sign-in, sign-up and reset request a human's.
const RATES = {
  login: '20/min',
  loginAccountFailures: '20/hour',

  register: '30/hour',
  verifyRequest: '3/hour',
  refresh: '10/min',
  passwordChange: '5/min',
  pushDevice: '30/min',
  passwordResetRequest: '10/hour',
  /** Per (address, caller): what one caller can ask for one address. */
  passwordResetRequestPair: '3/hour',
  emailChange: '5/hour',
  schoolRequest: '5/hour',
  publicProfile: '30/min',
  passkeyLogin: '10/min',
  passkeyRegister: '10/hour',
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

/**
 * Sign-in, registration and asking for a reset link always need a Turnstile
 * token: a script posting to the API directly would otherwise get a few free
 * guesses or mail sends per IP before any challenge. Without Turnstile
 * configured this does nothing. Without a token the answer carries the site key, so the app
 * can show the widget and send the request again.
 */
async function assertChallenge(c: C, token: unknown): Promise<void> {
  if (!turnstileEnabled(c.env)) return;
  const site = { site_key: c.env.TURNSTILE_SITE_KEY };
  if (!token) apiError(403, 'auth.errChallengeRequired', site);
  if (!(await verifyTurnstile(c.env, token, c.req.header('CF-Connecting-IP')))) apiError(403, 'auth.errChallengeFailed', site);
}

accountRoutes.post('/register', rateLimit('register', RATES.register), async (c) => {
  const body = await readJson(c.req);
  await assertChallenge(c, body.cf_turnstile_response);
  const fields: Record<string, string[]> = {};

  const rawEmail = body.email;
  let email = '';
  if (typeof rawEmail !== 'string' || !rawEmail.trim()) fields.email = ['auth.errFillEmailPassword'];
  else {
    email = rawEmail.trim().toLowerCase();
    if (!isPlainEmail(email)) fields.email = ['common.errEmailInvalid'];
  }

  const names: Record<'first_name' | 'last_name', string> = { first_name: '', last_name: '' };
  for (const key of ['first_name', 'last_name'] as const) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') fields[key] = ['common.errValidation'];
    else if (v.trim().length > NAME_MAX_LENGTH) fields[key] = ['acct.errNameTooLong'];
    else names[key] = v.trim();
  }

  const password = body.password;
  if (typeof password !== 'string' || !password) fields.password = ['auth.errFillEmailPassword'];
  else {
    const problems = passwordProblems(password);
    if (problems.length) fields.password = problems;
  }

  const existing = fields.email ? null : await getUserByEmail(c.env, email);
  const supersede = existing ? await ott.isPendingRegistration(c.env, existing) : false;
  if (existing && !supersede) fields.email = ['acct.errEmailTaken'];
  if (Object.keys(fields).length) fieldErrors(fields);

  // The password travels with the link, not on the row: only the person who
  // follows the link mailed for *this* registration sets the password the
  // account activates with. Someone registering an address they don't own
  // can neither block its owner nor leave a password on the account.
  const passwordHash = await hashPassword(password as string);
  const { firstName: fn, lastName: ln, name: nm } = nameColumns(names.first_name, names.last_name);
  if (existing && supersede) {
    await ott.voidRegistrationLinks(c.env, existing.id);
    await createDb(c.env.DB)
      .update(users)
      .set({ name: nm, firstName: fn, lastName: ln, passwordHash: null, updatedAt: nowIso() })
      .where(and(eq(users.id, existing.id), eq(users.isActive, 0)))
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
    await createDb(c.env.DB)
      .insert(users)
      .values({
        id,
        email,
        name,
        firstName,
        lastName,
        passwordHash: null,
        role: 'user',
        isActive: 0,
        isBanned: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) fieldErrors({ email: ['acct.errEmailTaken'] });
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
accountRoutes.post('/verify-registration', rateLimit('activate', RATES.login), async (c) => {
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
      await createDb(c.env.DB)
        .update(users)
        .set({
          isActive: 1,
          passwordHash: sql`COALESCE(${record.payload.password_hash ?? null}, ${users.passwordHash})`,
          updatedAt: nowIso(),
        })
        .where(and(eq(users.id, user.id), eq(users.isActive, 0), isNull(users.deletedAt)))
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

accountRoutes.post('/verify/request', authMiddleware(), rateLimit('verify-request', RATES.verifyRequest), async (c) => {
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

accountRoutes.post('/verify', async (c) => {
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

accountRoutes.post('/verify/auto', authMiddleware(), rateLimit('verify-request', RATES.verifyRequest), async (c) => {
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

accountRoutes.post('/verify/unbind', authMiddleware(), async (c) => {
  const region = await getRegion(c);
  if (!region) apiError(400, 'sys.errUnknownRegion');
  const res = await createDb(c.env.DB)
    .update(regionVerifications)
    .set({ isActive: 0 })
    .where(
      and(
        eq(regionVerifications.userId, c.get('user')!.id),
        eq(regionVerifications.regionCode, region.code),
        eq(regionVerifications.isActive, 1),
      ),
    )
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

/** The columns a school request answers with. */
const schoolRequestColumns = {
  id: schoolRequests.id,
  school_name: schoolRequests.schoolName,
  school_website: schoolRequests.schoolWebsite,
  edu_email: schoolRequests.eduEmail,
  status: schoolRequests.status,
  created_at: schoolRequests.createdAt,
};

async function pendingSchoolRequest(c: C, userId: string, region: string, name: string): Promise<SchoolRequestRow | null> {
  const [row] = await createDb(c.env.DB)
    .select(schoolRequestColumns)
    .from(schoolRequests)
    .where(
      and(
        eq(schoolRequests.userId, userId),
        eq(schoolRequests.regionCode, region),
        sql`lower(${schoolRequests.schoolName}) = lower(${name})`,
        eq(schoolRequests.status, 'pending'),
      ),
    )
    .limit(1);
  return row ?? null;
}

accountRoutes.post('/school-requests', authMiddleware(), rateLimit('school-request', RATES.schoolRequest), async (c) => {
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
    const [row] = await createDb(c.env.DB)
      .insert(schoolRequests)
      .values({
        regionCode: region.code,
        userId,
        schoolName: name,
        schoolWebsite: website,
        eduEmail,
        status: 'pending',
        adminNote: '',
        createdAt: now,
        updatedAt: now,
      })
      .returning(schoolRequestColumns);
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

accountRoutes.post('/login', rateLimit('login', RATES.login), async (c) => {
  const { email, password, cf_turnstile_response: challenge } = await readJson(c.req);
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    apiError(400, 'auth.errValidation');
  }
  // Per account too, not only per IP: a password guessed from many IPs.
  // Only wrong passwords count, so the owner's own sign-ins never use it up.
  const failures = outcomeLimit(c, 'login_account_failures', RATES.loginAccountFailures, email.trim().toLowerCase());
  if (turnstileEnabled(c.env)) {
    // With Turnstile, every sign-in needs a human check instead of the
    // account locking after failures: a stranger's guesses can no longer
    // keep the owner out, and a guessing script has to solve every challenge.
    await assertChallenge(c, challenge);
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
      if (await checkPassword(password, hash)) apiError(403, 'auth.errAccountNotActivated');
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
        createDb(c.env.DB)
          .update(users)
          .set({ passwordHash: h })
          .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash!)))
          .run(),
      ),
    );
  }

  const second = await beginSecondFactor(c, user);
  if (second) return second;
  setSession(c, await issueTokens(c.env, user.id));
  await touchLastLogin(c.env, user.id);
  return c.json({ code: 'auth.loginSuccess', user_id: user.id });
});

async function setPassword(c: C, userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await createDb(c.env.DB).update(users).set({ passwordHash, updatedAt: nowIso() }).where(eq(users.id, userId)).run();
}

accountRoutes.post('/refresh', rateLimit('refresh_token', RATES.refresh), async (c) => {
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

accountRoutes.post('/google', rateLimit('login', RATES.login), async (c) => {
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
      await createDb(c.env.DB)
        .insert(users)
        .values({
          id,
          email,
          ...cols,
          passwordHash: null,
          avatarUrl,
          role: 'user',
          isActive: 1,
          isBanned: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    user = await getUserByEmail(c.env, email);
    if (!user) throw new Error('google sign-in: user row missing after insert');
  } else if (avatarUrl && user.avatarUrl !== avatarUrl) {
    await createDb(c.env.DB).update(users).set({ avatarUrl, updatedAt: nowIso() }).where(eq(users.id, user.id)).run();
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
    await createDb(c.env.DB)
      .update(users)
      .set({ isActive: 1, passwordHash: null, updatedAt: nowIso() })
      .where(and(eq(users.id, user.id), eq(users.isActive, 0)))
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
      await createDb(c.env.DB)
        .update(users)
        .set({ googleId: claims.sub })
        .where(and(eq(users.id, user.id), isNull(users.googleId)))
        .run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      console.warn(`[accounts] Google account already linked to another user; not linking to ${user.id}`);
    }
  }

  const second = await beginSecondFactor(c, user);
  if (second) return second;
  setSession(c, await issueTokens(c.env, user.id));
  await touchLastLogin(c.env, user.id);
  const region = await getRegion(c);
  const isVerified = region ? await isVerifiedIn(c.env, user.id, region.code) : false;
  return c.json({ code: 'auth.loginSuccess', user_id: user.id, user: { is_verified: isVerified } });
});

accountRoutes.get('/config', (c) => {
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

accountRoutes.post('/logout', optionalAuthMiddleware(), async (c) => {
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
  // This browser's push registration goes with the session, here rather than
  // only in a separate request, which an expired access token could lose.
  const pushToken = body.push_token;
  if (userId && typeof pushToken === 'string' && pushToken && pushToken.length <= PUSH_TOKEN_MAX_LENGTH) {
    await createDb(c.env.DB)
      .delete(pushDevices)
      .where(and(eq(pushDevices.userId, userId), eq(pushDevices.token, pushToken)))
      .run();
  }
  return c.json({ code: 'auth.logoutSuccess' });
});

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn)
// ---------------------------------------------------------------------------

accountRoutes.post(
  '/passkeys/register/options',
  authMiddleware(),
  rateLimit('passkey-register', RATES.passkeyRegister),
  requireRecentSignIn(),
  async (c) => {
    const user = await currentUser(c);
    return getPasskeyRegistrationOptions(c, user);
  },
);
accountRoutes.post(
  '/passkeys/register/options/',
  authMiddleware(),
  rateLimit('passkey-register', RATES.passkeyRegister),
  requireRecentSignIn(),
  async (c) => {
    const user = await currentUser(c);
    return getPasskeyRegistrationOptions(c, user);
  },
);

accountRoutes.post(
  '/passkeys/register/verify',
  authMiddleware(),
  rateLimit('passkey-register', RATES.passkeyRegister),
  requireRecentSignIn(),
  async (c) => {
    const user = await currentUser(c);
    return verifyPasskeyRegistration(c, user);
  },
);
accountRoutes.post(
  '/passkeys/register/verify/',
  authMiddleware(),
  rateLimit('passkey-register', RATES.passkeyRegister),
  requireRecentSignIn(),
  async (c) => {
    const user = await currentUser(c);
    return verifyPasskeyRegistration(c, user);
  },
);

accountRoutes.post('/passkeys/login/options', rateLimit('passkey-login', RATES.passkeyLogin), async (c) => {
  return getPasskeyLoginOptions(c);
});

accountRoutes.post('/passkeys/login/verify', rateLimit('passkey-login', RATES.passkeyLogin), async (c) => {
  return verifyPasskeyLogin(c);
});

accountRoutes.post('/passkeys/2fa/verify', rateLimit('passkey-login', RATES.passkeyLogin), async (c) => {
  return verifySecondFactor(c);
});

accountRoutes.put('/passkeys/2fa', authMiddleware(), async (c) => {
  const user = await currentUser(c);
  return setPasskeyTwoStep(c, user);
});

accountRoutes.get('/passkeys', authMiddleware(), async (c) => {
  return listUserPasskeys(c, c.get('user')!.id);
});

accountRoutes.patch('/passkeys/:id', authMiddleware(), async (c) => {
  return renameUserPasskey(c, c.get('user')!.id, c.req.param('id'));
});

accountRoutes.delete('/passkeys/:id', authMiddleware(), requireRecentSignIn(), async (c) => {
  const user = await currentUser(c);
  return deleteUserPasskey(c, user, c.req.param('id'));
});

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

accountRoutes.post('/password', authMiddleware(), rateLimit('password_change', RATES.passwordChange), async (c) => {
  const user = await currentUser(c);
  const { old_password: oldPassword, new_password: newPassword } = await readJson(c.req);
  // Changes an existing password only. A Google-only account stays without
  // one: there is nothing to guess, and a session alone must not add a way in.
  if (!user.passwordHash) apiError(400, 'acct.errPasswordlessAccount');
  if (!newPassword || typeof newPassword !== 'string') apiError(400, 'common.errValidation');
  if (!oldPassword || typeof oldPassword !== 'string') apiError(400, 'common.errValidation');
  if (!(await checkPassword(oldPassword, user.passwordHash))) fieldErrors({ old_password: ['auth.errInvalidPassword'] });
  const problems = passwordProblems(newPassword, user);
  if (problems.length) fieldErrors({ new_password: problems });

  await setPassword(c, user.id, newPassword);
  // Every other session ends; this device gets a fresh pair. An email change
  // asked for under the old password goes too: whoever knew it could have
  // started one to their own address.
  await revokeAllTokensForUser(c.env, user.id);
  await ott.cancelEmailChange(c.env, user.id);
  setSession(c, await issueTokens(c.env, user.id));
  return c.json({ code: 'acct.passwordUpdated' });
});

accountRoutes.post('/password/remove', authMiddleware(), rateLimit('password_change', RATES.passwordChange), async (c) => {
  const user = await currentUser(c);
  const { password } = await readJson(c.req);
  if (!password || typeof password !== 'string') apiError(400, 'common.errValidation');
  // A password may go only when another way to sign in remains: a linked Google account or a passkey.
  if (!user.googleId && !(await countUserPasskeys(c.env, user.id))) apiError(400, 'auth.errNoOtherSignIn');
  if (isStaffRole(user.role)) apiError(400, 'auth.errStaffCannotRemovePassword');
  if (!user.passwordHash) apiError(400, 'auth.errNoUsablePassword');
  if (!(await checkPassword(password, user.passwordHash))) apiError(400, 'auth.errInvalidPassword');
  await createDb(c.env.DB).update(users).set({ passwordHash: null, updatedAt: nowIso() }).where(eq(users.id, user.id)).run();
  return c.json({ code: 'acct.passwordRemoved' });
});

accountRoutes.post('/password/reset/request', rateLimit('password-reset-request', RATES.passwordResetRequest), async (c) => {
  const { email: raw, cf_turnstile_response: challenge } = await readJson(c.req);
  if (!raw || typeof raw !== 'string') apiError(400, 'common.errValidation');
  await assertChallenge(c, challenge);
  const email = raw.trim();
  const sent = { code: 'acct.passwordResetSent' };
  // Per (address, caller) and, looser, per address, so one mailbox cannot be
  // flooded from many addresses while a stranger asking for someone's address
  // uses up their own allowance, not the owner's. Checked for every address,
  // known or not, so the limit says nothing about which ones exist. Over it,
  // the request gets the usual answer and no email.
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  const key = email.toLowerCase();
  if (
    !(await takeRate(c, 'password-reset-request-pair', RATES.passwordResetRequestPair, `email:${key}|ip:${ip}`)) ||
    !(await takeRate(c, 'password-reset-request-email', RATES.passwordResetRequest, `email:${key}`))
  ) {
    return c.json(sent);
  }

  const user = await getUserByEmail(c.env, email);
  // The same answer whatever happens: no way to probe which addresses exist.
  // Google-linked accounts included: a mailbox link is how a passwordless account gets a password back.
  if (!user || accountDisabled(user)) return c.json(sent);

  const token = await ott.issue(c.env, ott.PASSWORD_RESET, user.id, ott.PASSWORD_RESET_TTL);
  await sendLinkEmail(c, 'passwordReset', user.id, user.email, '', `/forgot-password?token=${token}`);
  return c.json(sent);
});

accountRoutes.post('/password/reset/confirm', async (c) => {
  const { token, new_password: newPassword } = await readJson(c.req);
  if (!token) apiError(400, 'auth.errMissingToken');
  if (!newPassword || typeof newPassword !== 'string') apiError(400, 'common.errValidation');
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
  if (problems.length) fieldErrors({ new_password: problems });
  if (!(await ott.consume(c.env, record.id))) apiError(400, 'auth.errInvalidToken');

  await setPassword(c, user.id, newPassword);
  // Any existing session may be the compromised credential this reset fixes,
  // and so may a pending email change to someone else's address.
  await revokeAllTokensForUser(c.env, user.id);
  await ott.cancelEmailChange(c.env, user.id);
  return c.json({ code: 'acct.passwordResetSuccess' });
});

// ---------------------------------------------------------------------------
// Email change
// ---------------------------------------------------------------------------

accountRoutes.post('/email/change/confirm', rateLimit('password_change', RATES.passwordChange), async (c) => {
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
  if (await emailTakenByOther(c, newEmail, user.id)) {
    await ott.cancelEmailChange(c.env, user.id);
    apiError(400, 'acct.errEmailTaken');
  }
  if (await isValidEduEmail(c.env, newEmail)) {
    await ott.cancelEmailChange(c.env, user.id);
    apiError(400, 'acct.errEduEmailChangeNotAllowed');
  }
  try {
    await createDb(c.env.DB).update(users).set({ email: newEmail, updatedAt: nowIso() }).where(eq(users.id, user.id)).run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    await ott.cancelEmailChange(c.env, user.id);
    apiError(400, 'acct.errEmailTaken');
  }
  await ott.cancelEmailChange(c.env, user.id);
  // The old address hears about it: if the change was not the owner's, this
  // is the only warning that reaches them.
  const notice: EmailMessage = { type: 'email_changed', user_id: user.id, to: user.email, new_email: newEmail };
  try {
    await c.env.EMAIL_QUEUE.send(notice);
  } catch (e) {
    console.error(`[accounts] could not queue the email-changed notice for user ${user.id}`, e);
  }
  return c.json({ code: 'acct.emailChanged' });
});

accountRoutes.post('/email/change/cancel', authMiddleware(), async (c) => {
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

  // 用 D1 batch 將狀態計數、分頁總筆數與分頁資料合併為單次往返
  const countStmt = db
    .select({ status: listings.status, n: sql<number>`count(*)` })
    .from(listings)
    .where(and(eq(listings.sellerId, userId), eq(listings.regionCode, regionCode)))
    .groupBy(listings.status);
  const totalStmt = db
    .select({ n: sql<number>`count(*)` })
    .from(listings)
    .innerJoin(books, eq(books.id, listings.bookId))
    .where(where);
  const rowsStmt = db
    .select({ listing: listings })
    .from(listings)
    .innerJoin(books, eq(books.id, listings.bookId))
    .where(where)
    .orderBy(...(LISTING_SORTS[c.req.query('sort') ?? ''] ?? LISTING_SORTS.newest))
    .limit(page.limit)
    .offset(page.offset);

  const [countRows, totalRows, rows] = await db.batch([countStmt, totalStmt, rowsStmt]);

  let all = 0;
  for (const r of countRows) {
    counts[r.status] = Number(r.n);
    all += Number(r.n);
  }

  const results = await serializeListings(
    c.env,
    rows.map((r) => r.listing),
    { viewerId: userId, lang },
  );
  return { counts: { ...counts, all }, page: page.wrap(results, Number(totalRows[0]?.n ?? 0)) };
}

async function mySubscriptions(c: C, userId: string, regionCode: string | null) {
  if (!regionCode) return [];
  const results = await createDb(c.env.DB)
    .select({
      id: subscriptions.id,
      book_id: subscriptions.bookId,
      created_at: subscriptions.createdAt,
      title: books.title,
      isbn13: books.isbn13,
      cover_url: books.coverUrl,
      new_count: sql<number>`(SELECT COUNT(DISTINCT ${listings.id}) FROM ${listings}
        WHERE ${listings.bookId} = ${subscriptions.bookId} AND ${listings.status} = 'active' AND ${listings.createdAt} > ${subscriptions.createdAt})`,
    })
    .from(subscriptions)
    .innerJoin(books, eq(books.id, subscriptions.bookId))
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.regionCode, regionCode)))
    .orderBy(desc(subscriptions.createdAt));
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

accountRoutes.get('/me', authMiddleware(), async (c) => {
  const userId = c.get('user')!.id;
  const includeParam = c.req.query('include') ?? '';
  const includes = includeParam ? includeParam.split(',').map((s) => s.trim().toLowerCase()) : [];
  // 保持相容性：若帶有 status/sort/q/page（且非預設 page=1）查詢參數，視同要求刊登清單
  const hasListingParams =
    c.req.query('status') !== undefined ||
    c.req.query('sort') !== undefined ||
    c.req.query('q') !== undefined ||
    (c.req.query('page') !== undefined && c.req.query('page') !== '1');
  const wantListings = includes.includes('listings') || hasListingParams;
  const wantSubscriptions = includes.includes('subscriptions');

  // 若不需清單（header 與一般頁面用的 bare /me）：只平行查詢 currentUser 與 pending_email
  if (!wantListings && !wantSubscriptions) {
    const [user, pendingEmail] = await Promise.all([currentUser(c), ott.pendingEmailChange(c.env, userId)]);
    const data = await serializeUser(c, user);
    return c.json({
      ...data,
      pending_email: pendingEmail,
    });
  }

  // 帶有 include 時：currentUser、pendingEmail、region、lang 先行並行查詢
  const [user, pendingEmail, region, lang] = await Promise.all([
    currentUser(c),
    ott.pendingEmailChange(c.env, userId),
    getRegion(c),
    resolveLanguage(c),
  ]);
  const regionCode = region?.code ?? null;

  // serializeUser、myListingsBlock 與 mySubscriptions 並行處理
  const [data, listingsBlock, subs] = await Promise.all([
    serializeUser(c, user),
    wantListings ? myListingsBlock(c, userId, regionCode, lang) : Promise.resolve(null),
    wantSubscriptions ? mySubscriptions(c, userId, regionCode) : Promise.resolve(null),
  ]);

  const res: Record<string, unknown> = {
    ...data,
    pending_email: pendingEmail,
  };
  if (wantListings && listingsBlock) {
    res.myListingCounts = listingsBlock.counts;
    res.myListings = listingsBlock.page;
  }
  if (wantSubscriptions && subs) {
    res.mySubscriptions = subs;
  }
  return c.json(res);
});

/** An ISO 8601 date-time, or null when it does not parse. */
function parseDateTime(value: string): string | null {
  if (!/^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{1,2}/.test(value)) return null;
  const d = new Date(value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

accountRoutes.patch('/me', authMiddleware(), async (c) => {
  const user = await currentUser(c);
  const body = await readJson(c.req);
  const { first_name: firstName, last_name: lastName, email, show_avatar: showAvatar } = body;

  if (showAvatar !== undefined && showAvatar !== null && typeof showAvatar !== 'boolean')
    fieldErrors({ show_avatar: ['common.errValidation'] });
  for (const [key, value] of [
    ['first_name', firstName],
    ['last_name', lastName],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') fieldErrors({ [key]: ['common.errValidation'] });
    if (value.trim().length > NAME_MAX_LENGTH) fieldErrors({ [key]: ['acct.errNameTooLong'] });
  }
  for (const key of ['last_seen_bought_orders_at', 'last_seen_sold_orders_at'] as const) {
    const v = body[key];
    if (v !== undefined && v !== null && typeof v !== 'string') fieldErrors({ [key]: ['common.errValidation'] });
  }
  if (email !== undefined && email !== null && typeof email !== 'string') fieldErrors({ email: ['common.errValidation'] });

  let sets: Partial<InsertUser> = {};
  if (typeof showAvatar === 'boolean' && showAvatar !== !!user.showAvatar) sets.showAvatar = showAvatar ? 1 : 0;
  if (typeof firstName === 'string' || typeof lastName === 'string') {
    Object.assign(
      sets,
      nameColumns(
        typeof firstName === 'string' ? firstName.trim() : user.firstName,
        typeof lastName === 'string' ? lastName.trim() : user.lastName,
      ),
    );
  }
  const saveFields = async () => {
    if (!Object.keys(sets).length) return;
    await createDb(c.env.DB)
      .update(users)
      .set({ ...sets, updatedAt: nowIso() })
      .where(eq(users.id, user.id))
      .run();
    sets = {};
  };

  if (typeof email === 'string') {
    const newEmail = email.trim().toLowerCase();
    if (newEmail !== user.email) {
      if (user.googleId) fieldErrors({ email: ['acct.errGoogleEmailLocked'] });
      if (!isPlainEmail(newEmail)) fieldErrors({ email: ['common.errEmailInvalid'] });
      if (await emailTakenByOther(c, newEmail, user.id)) fieldErrors({ email: ['acct.errEmailTaken'] });
      // A campus address as the sign-in email is what auto-verify trusts; it
      // is only ever set by registration or Google, never edited in.
      if (await isValidEduEmail(c.env, newEmail)) apiError(400, 'acct.errEduEmailChangeNotAllowed');
      // A session alone does not move the sign-in address: the link would let
      // whoever holds it reset the password and keep the account.
      const currentPassword = body.current_password;
      if (typeof currentPassword !== 'string' || !currentPassword) fieldErrors({ current_password: ['acct.errCurrentPasswordRequired'] });
      if (!(await checkPassword(currentPassword, user.passwordHash))) fieldErrors({ current_password: ['auth.errInvalidPassword'] });
      // Each request mails a link to an address the caller chose: limited per
      // account and per recipient, so no mailbox can be flooded from here.
      // Counted only past the password, so nobody spends a stranger's
      // allowance for an address with wrong guesses.
      if (
        !(await takeRate(c, 'email-change', RATES.emailChange)) ||
        !(await takeRate(c, 'email-change-recipient', RATES.emailChange, `email:${newEmail}`))
      ) {
        apiError(429, 'common.errThrottled');
      }
      // Not applied here: only once the link mailed to the new address is followed.
      // The other fields are saved first, so an error there leaves no live link.
      await saveFields();
      const token = await ott.issueEmailChange(c.env, user.id, newEmail);
      await sendLinkEmail(c, 'emailChange', user.id, newEmail, '', `/account/settings?email_change_token=${token}`);
      return c.json({ code: 'acct.emailChangePending', pending_email: newEmail });
    }
  }

  for (const [key, column] of [
    ['last_seen_bought_orders_at', 'lastSeenBoughtOrdersAt'],
    ['last_seen_sold_orders_at', 'lastSeenSoldOrdersAt'],
  ] as const) {
    const v = body[key];
    if (typeof v === 'string') sets[column] = v ? parseDateTime(v) : null;
    else if (v === null) sets[column] = null;
  }
  await saveFields();
  const fresh = await currentUser(c);
  return c.json(await serializeUser(c, fresh));
});

accountRoutes.delete('/me', authMiddleware(), requireRecentSignIn(), async (c) => {
  // Irreversible: a session alone (a stolen cookie, a browser left open) is not enough.
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

accountRoutes.get('/me/notifications', authMiddleware(), async (c) => {
  return c.json(notificationSettings(await currentUser(c)));
});

accountRoutes.patch('/me/notifications', authMiddleware(), async (c) => {
  const user = await currentUser(c);
  const body = await readJson(c.req);
  const sets: Partial<InsertUser> = {};
  for (const [key, column] of [
    ['new_message_email', 'notifyNewMessageEmail'],
    ['push', 'notifyPush'],
  ] as const) {
    if (!(key in body)) continue;
    const v = parseBoolField(body[key]);
    if (v === undefined) apiError(400, 'common.errValidation');
    sets[column] = v ? 1 : 0;
  }
  if ('email_language' in body) {
    const v = body.email_language;
    if (typeof v !== 'string' || ![EMAIL_LANGUAGE_AUTO, ...EMAIL_LANGUAGES].includes(v)) apiError(400, 'common.errValidation');
    sets.emailLanguage = v;
  }
  // site_language is read-only here (its own endpoint writes it); anything else is ignored.
  if (Object.keys(sets).length) {
    await createDb(c.env.DB)
      .update(users)
      .set({ ...sets, updatedAt: nowIso() })
      .where(eq(users.id, user.id))
      .run();
  }
  return c.json(notificationSettings(await currentUser(c)));
});

function pushToken(body: Record<string, unknown>): string | null {
  const token = body.token;
  if (typeof token !== 'string' || !token.trim() || token.length > PUSH_TOKEN_MAX_LENGTH) return null;
  return token.trim();
}

accountRoutes.post('/me/push-devices', authMiddleware(), rateLimit('push_device', RATES.pushDevice), async (c) => {
  const token = pushToken(await readJson(c.req));
  if (!token) apiError(400, 'common.errValidation');
  const now = nowIso();
  // Keyed on the token alone: registering one another account holds moves it here.
  await createDb(c.env.DB)
    .insert(pushDevices)
    .values({ userId: c.get('user')!.id, token, platform: 'web', isActive: 1, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: pushDevices.token,
      set: { userId: sql`excluded.user_id`, isActive: 1, updatedAt: sql`excluded.updated_at` },
    })
    .run();
  return c.body(null, 204);
});

accountRoutes.delete('/me/push-devices', authMiddleware(), rateLimit('push_device', RATES.pushDevice), async (c) => {
  const token = pushToken(await readJson(c.req));
  if (!token) apiError(400, 'common.errValidation');
  // Only ever the caller's own device.
  await createDb(c.env.DB)
    .delete(pushDevices)
    .where(and(eq(pushDevices.userId, c.get('user')!.id), eq(pushDevices.token, token)))
    .run();
  return c.body(null, 204);
});

accountRoutes.put('/me/site-language', authMiddleware(), async (c) => {
  const { language } = await readJson(c.req);
  if (typeof language !== 'string' || !EMAIL_LANGUAGES.includes(language)) apiError(400, 'common.errValidation');
  await createDb(c.env.DB)
    .update(users)
    .set({ siteLanguage: language })
    .where(and(eq(users.id, c.get('user')!.id), ne(users.siteLanguage, language)))
    .run();
  return c.body(null, 204);
});

accountRoutes.put('/me/site-region', authMiddleware(), async (c) => {
  const { region } = await readJson(c.req);
  const userId = c.get('user')!.id;
  if (typeof region !== 'string' || !region || !(await isVerifiedIn(c.env, userId, region.toUpperCase()))) {
    apiError(400, 'common.errValidation');
  }
  const code = region.toUpperCase();
  await createDb(c.env.DB)
    .update(users)
    .set({ siteRegion: code })
    .where(and(eq(users.id, userId), ne(users.siteRegion, code)))
    .run();
  return c.body(null, 204);
});

accountRoutes.get('/users/:id', optionalAuthMiddleware(), rateLimit('public_profile', RATES.publicProfile), async (c) => {
  const id = c.req.param('id');
  const user = UUID_RE.test(id) ? await getUser(c.env, id) : null;
  if (!user) apiError(404, 'auth.errUserNotFound');
  // A switched-off, banned or never-activated account has no public face (a
  // squatted sign-up's name is whatever a stranger typed). A deleted one is
  // already anonymized and stays, for the orders and chats that link to it.
  const hidden = !user.deletedAt && (!user.isActive || !!user.isBanned);
  if (hidden && !c.get('user')?.isStaff) apiError(404, 'auth.errUserNotFound');
  return c.json(await serializePublicUser(c, user));
});
