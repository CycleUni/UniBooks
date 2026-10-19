import type { Context } from 'hono';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { createDb, passkeys, users, type User } from '../../db';
import { apiError, fieldErrors, readJson } from '../../lib/http';
import { setSession } from '../../lib/session';
import { nowIso } from '../../lib/time';
import { issueTokens } from './tokens';
import { getUser } from './users';
import type { ChallengeRecord, ChallengeStore } from '../../durable-objects/ChallengeStore';

export type { ChallengeRecord } from '../../durable-objects/ChallengeStore';

type C = Context<AppEnv>;

const CHALLENGE_TTL_SECONDS = 120;
const PASSKEY_NAME_MAX_LENGTH = 150;

export const webauthnVerifier = {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
};

function challengeStore(env: AppEnv['Bindings'], id: string) {
  const ns = env.CHALLENGE_STORE as DurableObjectNamespace<ChallengeStore>;
  return ns.get(ns.idFromName(id));
}

export interface PasskeyCatalogueEntry {
  name: string;
  light: string | null;
  dark: string | null;
}

export type PasskeyCatalogue = Record<string, PasskeyCatalogueEntry>;

let catalogueCache: PasskeyCatalogue | null = null;

export function clearCatalogueCache(): void {
  catalogueCache = null;
}

export async function loadCatalogue(env: AppEnv['Bindings'], origin = 'http://localhost'): Promise<PasskeyCatalogue> {
  if (catalogueCache) {
    return catalogueCache;
  }
  try {
    if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
      return {};
    }
    const res = await env.ASSETS.fetch(new URL('/passkey-icons/names.json', origin));
    if (!res.ok) {
      return {};
    }
    const data = (await res.json()) as PasskeyCatalogue;
    catalogueCache = data;
    return catalogueCache;
  } catch {
    return {};
  }
}

/**
 * Default passkey label derived from catalogue for aaguid, or deviceType/transports.
 */
export function defaultPasskeyName(
  optionsOrUserAgent?:
    | {
        aaguid?: string | null;
        catalogue?: PasskeyCatalogue;
        deviceType?: string;
        transports?: string[] | null;
      }
    | string
    | null,
): string {
  if (typeof optionsOrUserAgent === 'string' || optionsOrUserAgent === null || optionsOrUserAgent === undefined) {
    return 'Passkey';
  }
  if (optionsOrUserAgent.aaguid && optionsOrUserAgent.catalogue && optionsOrUserAgent.catalogue[optionsOrUserAgent.aaguid]?.name) {
    return optionsOrUserAgent.catalogue[optionsOrUserAgent.aaguid].name;
  }
  if (optionsOrUserAgent.deviceType === 'multiDevice') {
    return 'Passkey (synced)';
  }
  const transports = optionsOrUserAgent.transports ?? [];
  if (transports.includes('usb') || transports.includes('nfc')) {
    return 'Security key';
  }
  return 'Passkey';
}

function webAuthnConfig(reqUrl: string) {
  const url = new URL(reqUrl);
  return {
    rpID: url.hostname,
    expectedOrigin: url.origin,
    rpName: 'UniBooks',
  };
}

function accountDisabled(user: { isActive: number; isBanned: number; deletedAt: string | null }): boolean {
  return !user.isActive || !!user.isBanned || !!user.deletedAt;
}

async function touchLastLogin(c: C, userId: string): Promise<void> {
  await createDb(c.env.DB).update(users).set({ lastLoginAt: nowIso() }).where(eq(users.id, userId)).run();
}

/**
 * Generate WebAuthn registration options for the signed-in user and store the challenge in the ChallengeStore DO.
 */
export async function getPasskeyRegistrationOptions(c: C, user: User) {
  const { rpID, rpName } = webAuthnConfig(c.req.url);
  const db = createDb(c.env.DB);
  const existingPasskeys = await db
    .select({ id: passkeys.id, transports: passkeys.transports })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userID: isoUint8Array.fromUTF8String(user.id),
    attestationType: 'none',
    excludeCredentials: existingPasskeys.map((p) => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  const challengeId = crypto.randomUUID();
  const chalRecord: ChallengeRecord = {
    challenge: options.challenge,
    type: 'reg',
    userId: user.id,
  };
  await challengeStore(c.env, challengeId).put(chalRecord, CHALLENGE_TTL_SECONDS);

  return c.json({ challenge_id: challengeId, options });
}

/**
 * Verify a WebAuthn registration response and save the passkey row.
 */
export async function verifyPasskeyRegistration(c: C, user: User) {
  const body = await readJson(c.req);
  const challengeId = body.challenge_id;
  const response = body.response as RegistrationResponseJSON | undefined;
  if (!challengeId || typeof challengeId !== 'string' || !response) {
    apiError(400, 'auth.errPasskeyChallenge');
  }

  const record = await challengeStore(c.env, challengeId).take();

  if (!record || record.type !== 'reg' || record.userId !== user.id) {
    apiError(400, 'auth.errPasskeyChallenge');
  }

  const { rpID, expectedOrigin } = webAuthnConfig(c.req.url);

  let verification;
  try {
    verification = await webauthnVerifier.verifyRegistrationResponse({
      response,
      expectedChallenge: record.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    apiError(400, 'auth.errPasskeyRegistration');
  }

  if (!verification || !verification.verified || !verification.registrationInfo) {
    apiError(400, 'auth.errPasskeyRegistration');
  }

  const { registrationInfo } = verification;
  const rawName = body.name;
  let passkeyName = '';
  const transports = registrationInfo.credential.transports ?? response.response?.transports;
  if (typeof rawName === 'string' && rawName.trim()) {
    passkeyName = rawName.trim().slice(0, PASSKEY_NAME_MAX_LENGTH);
  } else {
    const catalogue = await loadCatalogue(c.env, new URL(c.req.url).origin);
    passkeyName = defaultPasskeyName({
      aaguid: registrationInfo.aaguid,
      catalogue,
      deviceType: registrationInfo.credentialDeviceType,
      transports,
    });
  }

  const transportsJson = transports && transports.length ? JSON.stringify(transports) : null;
  const now = nowIso();

  const db = createDb(c.env.DB);
  await db
    .insert(passkeys)
    .values({
      id: registrationInfo.credential.id,
      userId: user.id,
      publicKey: isoBase64URL.fromBuffer(registrationInfo.credential.publicKey),
      counter: registrationInfo.credential.counter,
      transports: transportsJson,
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp ? 1 : 0,
      name: passkeyName,
      aaguid: registrationInfo.aaguid ?? null,
      createdAt: now,
      lastUsedAt: null,
    })
    .run();

  return c.json({ id: registrationInfo.credential.id, name: passkeyName }, 201);
}

/**
 * Generate WebAuthn authentication options (discoverable credential) and store the challenge in the ChallengeStore DO.
 */
export async function getPasskeyLoginOptions(c: C) {
  const { rpID } = webAuthnConfig(c.req.url);

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: [],
  });

  const challengeId = crypto.randomUUID();
  const chalRecord: ChallengeRecord = {
    challenge: options.challenge,
    type: 'auth',
  };
  await challengeStore(c.env, challengeId).put(chalRecord, CHALLENGE_TTL_SECONDS);

  return c.json({ challenge_id: challengeId, options });
}

/**
 * Verify WebAuthn authentication response, issue session cookies, and touch last login.
 */
export async function verifyPasskeyLogin(c: C) {
  const body = await readJson(c.req);
  const challengeId = body.challenge_id;
  const response = body.response as AuthenticationResponseJSON | undefined;
  if (!challengeId || typeof challengeId !== 'string' || !response || !response.id) {
    apiError(400, 'auth.errPasskeyChallenge');
  }

  const record = await challengeStore(c.env, challengeId).take();

  if (!record || record.type !== 'auth') {
    apiError(400, 'auth.errPasskeyChallenge');
  }

  const db = createDb(c.env.DB);
  const [passkey] = await db.select().from(passkeys).where(eq(passkeys.id, response.id)).limit(1);
  if (!passkey) {
    apiError(401, 'auth.errPasskeyLogin');
  }

  const user = await getUser(c.env, passkey.userId);
  if (!user) {
    apiError(401, 'auth.errPasskeyLogin');
  }

  const { rpID, expectedOrigin } = webAuthnConfig(c.req.url);

  let verification;
  try {
    verification = await webauthnVerifier.verifyAuthenticationResponse({
      response,
      expectedChallenge: record.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    apiError(401, 'auth.errPasskeyLogin');
  }

  if (!verification || !verification.verified) {
    apiError(401, 'auth.errPasskeyLogin');
  }

  // Account disabled gate (same as password login)
  if (accountDisabled(user)) {
    apiError(403, 'auth.errAccountDisabled');
  }

  const { authenticationInfo } = verification;
  const now = nowIso();
  await db
    .update(passkeys)
    .set({
      counter: authenticationInfo.newCounter,
      backedUp: authenticationInfo.credentialBackedUp ? 1 : 0,
      deviceType: authenticationInfo.credentialDeviceType ?? passkey.deviceType,
      lastUsedAt: now,
    })
    .where(eq(passkeys.id, passkey.id))
    .run();

  await touchLastLogin(c, user.id);
  setSession(c, await issueTokens(c.env, user.id));
  return c.json({ code: 'auth.loginSuccess', user_id: user.id });
}

/**
 * Second sign-in step. Called after the password (or Google) check has passed
 * for an account with passkey two-step on: no session yet, only a challenge
 * limited to this user's own passkeys. Returns null when two-step is off.
 */
export async function beginSecondFactor(c: C, user: User) {
  if (!user.passkey2fa) return null;
  const db = createDb(c.env.DB);
  const own = await db.select({ id: passkeys.id, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.userId, user.id));
  // Nothing to ask for (every passkey was removed): do not lock the owner out.
  if (own.length === 0) return null;

  const { rpID } = webAuthnConfig(c.req.url);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: own.map((p) => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
  });
  const challengeId = crypto.randomUUID();
  const record: ChallengeRecord = { challenge: options.challenge, type: 'mfa', userId: user.id };
  await challengeStore(c.env, challengeId).put(record, CHALLENGE_TTL_SECONDS);
  return c.json({ code: 'auth.passkeyRequired', challenge_id: challengeId, options });
}

/**
 * Check the passkey for a pending second step, then start the session.
 * One attempt per challenge: a wrong answer means signing in again.
 */
export async function verifySecondFactor(c: C) {
  const body = await readJson(c.req);
  const challengeId = body.challenge_id;
  const response = body.response as AuthenticationResponseJSON | undefined;
  if (!challengeId || typeof challengeId !== 'string' || !response || !response.id) {
    apiError(400, 'auth.errPasskeyChallenge');
  }

  const record = await challengeStore(c.env, challengeId).take();
  if (!record || record.type !== 'mfa' || !record.userId) {
    apiError(400, 'auth.errPasskeyChallenge');
  }

  const db = createDb(c.env.DB);
  const [passkey] = await db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, response.id), eq(passkeys.userId, record.userId)))
    .limit(1);
  if (!passkey) {
    apiError(401, 'auth.errPasskeyLogin');
  }
  const user = await getUser(c.env, record.userId);
  if (!user) {
    apiError(401, 'auth.errPasskeyLogin');
  }

  const { rpID, expectedOrigin } = webAuthnConfig(c.req.url);
  let verification;
  try {
    verification = await webauthnVerifier.verifyAuthenticationResponse({
      response,
      expectedChallenge: record.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    apiError(401, 'auth.errPasskeyLogin');
  }
  if (!verification || !verification.verified) {
    apiError(401, 'auth.errPasskeyLogin');
  }
  if (accountDisabled(user)) {
    apiError(403, 'auth.errAccountDisabled');
  }

  const { authenticationInfo } = verification;
  await db
    .update(passkeys)
    .set({
      counter: authenticationInfo.newCounter,
      backedUp: authenticationInfo.credentialBackedUp ? 1 : 0,
      deviceType: authenticationInfo.credentialDeviceType ?? passkey.deviceType,
      lastUsedAt: nowIso(),
    })
    .where(eq(passkeys.id, passkey.id))
    .run();

  await touchLastLogin(c, user.id);
  setSession(c, await issueTokens(c.env, user.id));
  return c.json({ code: 'auth.loginSuccess', user_id: user.id });
}

/** Turn passkey two-step on or off. Turning it on needs a passkey to ask for. */
export async function setPasskeyTwoStep(c: C, user: User) {
  const body = await readJson(c.req);
  if (typeof body.enabled !== 'boolean') {
    apiError(400, 'common.errValidation');
  }
  if (body.enabled && (await countUserPasskeys(c.env, user.id)) === 0) {
    apiError(409, 'acct.errTwoStepNeedsPasskey');
  }
  await createDb(c.env.DB)
    .update(users)
    .set({ passkey2fa: body.enabled ? 1 : 0, updatedAt: nowIso() })
    .where(eq(users.id, user.id))
    .run();
  return c.json({ passkey_2fa: body.enabled });
}

/**
 * List the current user's registered passkeys.
 */
export async function listUserPasskeys(c: C, userId: string) {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      id: passkeys.id,
      name: passkeys.name,
      aaguid: passkeys.aaguid,
      created_at: passkeys.createdAt,
      last_used_at: passkeys.lastUsedAt,
      device_type: passkeys.deviceType,
      backed_up: passkeys.backedUp,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(desc(passkeys.createdAt));

  const catalogue = await loadCatalogue(c.env, new URL(c.req.url).origin);

  return c.json(
    rows.map((r) => {
      const entry = r.aaguid ? catalogue[r.aaguid] : undefined;
      const iconLight = entry?.light ? (entry.light.startsWith('/') ? entry.light : `/passkey-icons/${entry.light}`) : null;
      const iconDark = entry?.dark ? (entry.dark.startsWith('/') ? entry.dark : `/passkey-icons/${entry.dark}`) : null;

      return {
        id: r.id,
        name: r.name,
        aaguid: r.aaguid ?? null,
        provider: entry?.name ?? null,
        icon_light: iconLight,
        icon_dark: iconDark,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
        device_type: r.device_type,
        backed_up: !!r.backed_up,
      };
    }),
  );
}

/**
 * Rename an owned passkey.
 */
export async function renameUserPasskey(c: C, userId: string, passkeyId: string) {
  const body = await readJson(c.req);
  const rawName = body.name;
  if (typeof rawName !== 'string' || !rawName.trim()) {
    apiError(400, 'common.errValidation');
  }
  const name = rawName.trim();
  if (name.length > PASSKEY_NAME_MAX_LENGTH) {
    fieldErrors({ name: ['acct.errNameTooLong'] });
  }

  const db = createDb(c.env.DB);
  const [passkey] = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId)))
    .limit(1);

  if (!passkey) {
    apiError(404, 'auth.errPasskeyNotFound');
  }

  await db
    .update(passkeys)
    .set({ name })
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId)))
    .run();

  return c.json({ id: passkeyId, name });
}

/**
 * Delete an owned passkey, guarded against removing the user's only sign-in method.
 */
/** How many passkeys the user has registered. */
export async function countUserPasskeys(env: AppEnv['Bindings'], userId: string): Promise<number> {
  const [row] = await createDb(env.DB)
    .select({ count: sql<number>`count(*)` })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  return Number(row?.count ?? 0);
}

export async function deleteUserPasskey(c: C, user: User, passkeyId: string) {
  const db = createDb(c.env.DB);
  const [passkey] = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, user.id)))
    .limit(1);

  if (!passkey) {
    apiError(404, 'auth.errPasskeyNotFound');
  }

  // Last-method guard: deleting a passkey is refused when user has no password, no googleId, and it is their last passkey
  if (!user.passwordHash && !user.googleId) {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(passkeys)
      .where(eq(passkeys.userId, user.id));

    if (Number(countRow?.count ?? 0) <= 1) {
      apiError(409, 'acct.errLastSignInMethod');
    }
  }

  await db
    .delete(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, user.id)))
    .run();

  // No passkey left to ask for: two-step goes off with it.
  if (user.passkey2fa && (await countUserPasskeys(c.env, user.id)) === 0) {
    await db.update(users).set({ passkey2fa: 0, updatedAt: nowIso() }).where(eq(users.id, user.id)).run();
  }

  return c.body(null, 204);
}
