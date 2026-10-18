import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { clearCatalogueCache, loadCatalogue, webauthnVerifier } from '../../src/services/accounts/passkeys';
import { PASSWORD, call, createUser, login, seedReference, sessionOf } from './helpers';

let mockRegVerifyResult: any = null;
let mockAuthVerifyResult: any = null;
let mockRegVerifyThrows: Error | null = null;
let mockAuthVerifyThrows: Error | null = null;

const originalRegVerify = webauthnVerifier.verifyRegistrationResponse;
const originalAuthVerify = webauthnVerifier.verifyAuthenticationResponse;

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async (opts) => {
      if (mockRegVerifyThrows) throw mockRegVerifyThrows;
      if (mockRegVerifyResult) return mockRegVerifyResult;
      return actual.verifyRegistrationResponse(opts);
    }),
    verifyAuthenticationResponse: vi.fn(async (opts) => {
      if (mockAuthVerifyThrows) throw mockAuthVerifyThrows;
      if (mockAuthVerifyResult) return mockAuthVerifyResult;
      return actual.verifyAuthenticationResponse(opts);
    }),
  };
});

beforeAll(async () => {
  await seedReference();

  webauthnVerifier.verifyRegistrationResponse = async (opts) => {
    if (mockRegVerifyThrows) throw mockRegVerifyThrows;
    if (mockRegVerifyResult) return mockRegVerifyResult;
    return originalRegVerify(opts);
  };

  webauthnVerifier.verifyAuthenticationResponse = async (opts) => {
    if (mockAuthVerifyThrows) throw mockAuthVerifyThrows;
    if (mockAuthVerifyResult) return mockAuthVerifyResult;
    return originalAuthVerify(opts);
  };
});

afterEach(() => {
  mockRegVerifyResult = null;
  mockAuthVerifyResult = null;
  mockRegVerifyThrows = null;
  mockAuthVerifyThrows = null;
  clearCatalogueCache();
});

describe('Passkeys (WebAuthn)', () => {
  it('options endpoints: auth required for register, public for login, challenge stored in KV', async () => {
    // Register options requires auth
    const unauthed = await call('/api/v1/auth/passkeys/register/options/', { method: 'POST' });
    expect(unauthed.status).toBe(401);

    const userEmail = 'passkey-opts@example.com';
    const userId = await createUser(userEmail);
    const { access } = await login(userEmail);

    const regRes = await call('/api/v1/auth/passkeys/register/options/', { method: 'POST', token: access });
    expect(regRes.status).toBe(200);
    const regData = (await regRes.json()) as { challenge_id: string; options: any };
    expect(regData.challenge_id).toBeTruthy();
    expect(regData.options).toBeTruthy();
    expect(regData.options.challenge).toBeTruthy();

    // Verify KV stored the registration challenge
    const regKv = await env.KV.get(`webauthn:chal:${regData.challenge_id}`, 'json');
    expect(regKv).toEqual({
      challenge: regData.options.challenge,
      type: 'reg',
      userId,
    });

    // Login options is public (no auth)
    const loginRes = await call('/api/v1/auth/passkeys/login/options/', { method: 'POST' });
    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as { challenge_id: string; options: any };
    expect(loginData.challenge_id).toBeTruthy();
    expect(loginData.options).toBeTruthy();
    expect(loginData.options.allowCredentials).toEqual([]);

    // Verify KV stored the authentication challenge
    const authKv = await env.KV.get(`webauthn:chal:${loginData.challenge_id}`, 'json');
    expect(authKv).toEqual({
      challenge: loginData.options.challenge,
      type: 'auth',
    });
  });

  it('registration verify: unknown/consumed/wrong-type challenge_id rejected, consumed cannot be reused', async () => {
    const userEmail = 'passkey-reg-verify@example.com';
    await createUser(userEmail);
    const { access } = await login(userEmail);

    // Unknown challenge_id
    const unknownRes = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: { challenge_id: 'non-existent', response: { id: 'x' } },
    });
    expect(unknownRes.status).toBe(400);
    expect(await unknownRes.json()).toEqual({ error: { code: 'auth.errPasskeyChallenge' } });

    // Wrong type in challenge (type: 'auth' instead of 'reg')
    await env.KV.put('webauthn:chal:auth-type-chal', JSON.stringify({ challenge: 'c1', type: 'auth' }));
    const wrongTypeRes = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: { challenge_id: 'auth-type-chal', response: { id: 'x' } },
    });
    expect(wrongTypeRes.status).toBe(400);
    expect(await wrongTypeRes.json()).toEqual({ error: { code: 'auth.errPasskeyChallenge' } });

    // Challenge for another user
    await env.KV.put('webauthn:chal:other-user-chal', JSON.stringify({ challenge: 'c2', type: 'reg', userId: 'other-id' }));
    const otherUserRes = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: { challenge_id: 'other-user-chal', response: { id: 'x' } },
    });
    expect(otherUserRes.status).toBe(400);
    expect(await otherUserRes.json()).toEqual({ error: { code: 'auth.errPasskeyChallenge' } });

    // Valid challenge gets consumed; second try fails
    const optRes = await call('/api/v1/auth/passkeys/register/options/', { method: 'POST', token: access });
    const { challenge_id } = (await optRes.json()) as { challenge_id: string };

    mockRegVerifyThrows = new Error('simulated verify failure');
    const firstTry = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: { challenge_id, response: { id: 'x', response: {} } },
    });
    expect(firstTry.status).toBe(400);
    expect(await firstTry.json()).toEqual({ error: { code: 'auth.errPasskeyRegistration' } });

    // Replay with the same challenge_id: KV key is now deleted
    const replayTry = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: { challenge_id, response: { id: 'x', response: {} } },
    });
    expect(replayTry.status).toBe(400);
    expect(await replayTry.json()).toEqual({ error: { code: 'auth.errPasskeyChallenge' } });
  });

  it('registration verify: inserts row in database and returns 201', async () => {
    const userEmail = 'passkey-insert@example.com';
    const userId = await createUser(userEmail);
    const { access } = await login(userEmail);

    const optRes = await call('/api/v1/auth/passkeys/register/options/', { method: 'POST', token: access });
    const { challenge_id } = (await optRes.json()) as { challenge_id: string };

    const credId = 'test-cred-id-1';
    mockRegVerifyResult = {
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: {
          id: credId,
          publicKey: new Uint8Array([10, 20, 30, 40]),
          counter: 5,
          transports: ['internal'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array([0]),
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: 'http://x',
      },
    };

    const verifyRes = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: {
        challenge_id,
        response: { id: credId, response: { transports: ['internal'] } },
        name: 'My MacBook',
      },
    });
    expect(verifyRes.status).toBe(201);
    expect(await verifyRes.json()).toEqual({ id: credId, name: 'My MacBook' });

    // Verify row in DB
    const row = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(credId).first<any>();
    expect(row).toBeTruthy();
    expect(row.user_id).toBe(userId);
    expect(row.counter).toBe(5);
    expect(row.device_type).toBe('multiDevice');
    expect(row.backed_up).toBe(1);
    expect(row.name).toBe('My MacBook');
    expect(row.aaguid).toBe('00000000-0000-0000-0000-000000000000');
    expect(row.transports).toBe(JSON.stringify(['internal']));
  });

  it('login verify: unknown credential or failed verify returns 401 without revealing which', async () => {
    // Create an auth challenge in KV
    await env.KV.put('webauthn:chal:auth-chal-1', JSON.stringify({ challenge: 'c-auth', type: 'auth' }));

    // Non-existent credential id
    const resUnknownCred = await call('/api/v1/auth/passkeys/login/verify/', {
      body: { challenge_id: 'auth-chal-1', response: { id: 'unknown-cred' } },
    });
    expect(resUnknownCred.status).toBe(401);
    expect(await resUnknownCred.json()).toEqual({ error: { code: 'auth.errPasskeyLogin' } });

    // Register a valid passkey
    const userEmail = 'passkey-login-fail@example.com';
    const userId = await createUser(userEmail);
    const credId = 'cred-fail-verify';
    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at)
       VALUES (?, ?, 'pubkey', 0, 'singleDevice', 0, 'Passkey', datetime('now'))`,
    )
      .bind(credId, userId)
      .run();

    // Challenge with failing verify
    await env.KV.put('webauthn:chal:auth-chal-2', JSON.stringify({ challenge: 'c-auth', type: 'auth' }));
    mockAuthVerifyThrows = new Error('verification failed');

    const resFailedVerify = await call('/api/v1/auth/passkeys/login/verify/', {
      body: { challenge_id: 'auth-chal-2', response: { id: credId } },
    });
    expect(resFailedVerify.status).toBe(401);
    expect(await resFailedVerify.json()).toEqual({ error: { code: 'auth.errPasskeyLogin' } });
  });

  it('login verify: disabled/banned user returns 403', async () => {
    const userEmail = 'passkey-banned@example.com';
    const userId = await createUser(userEmail, { active: false });
    const credId = 'cred-banned-user';
    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at)
       VALUES (?, ?, 'pubkey', 0, 'singleDevice', 0, 'Passkey', datetime('now'))`,
    )
      .bind(credId, userId)
      .run();

    await env.KV.put('webauthn:chal:auth-chal-banned', JSON.stringify({ challenge: 'c-auth', type: 'auth' }));
    mockAuthVerifyResult = {
      verified: true,
      authenticationInfo: {
        credentialID: credId,
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://x',
        rpID: 'x',
      },
    };

    const res = await call('/api/v1/auth/passkeys/login/verify/', {
      body: { challenge_id: 'auth-chal-banned', response: { id: credId } },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'auth.errAccountDisabled' } });
  });

  it('login verify: updates counter and last_used_at, touches last_login_at, sets session cookies', async () => {
    const userEmail = 'passkey-success@example.com';
    const userId = await createUser(userEmail);
    const credId = 'cred-login-success';
    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at)
       VALUES (?, ?, 'pubkey', 2, 'singleDevice', 0, 'My Phone', datetime('now'))`,
    )
      .bind(credId, userId)
      .run();

    await env.KV.put('webauthn:chal:auth-chal-ok', JSON.stringify({ challenge: 'c-auth', type: 'auth' }));
    mockAuthVerifyResult = {
      verified: true,
      authenticationInfo: {
        credentialID: credId,
        newCounter: 10,
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://x',
        rpID: 'x',
      },
    };

    const res = await call('/api/v1/auth/passkeys/login/verify/', {
      body: { challenge_id: 'auth-chal-ok', response: { id: credId } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 'auth.loginSuccess', user_id: userId });

    // Session cookie set
    const session = sessionOf(res);
    expect(session.access).toBeTruthy();
    expect(session.refresh).toBeTruthy();

    // Verify counter and last_used_at in DB
    const passkeyRow = await env.DB.prepare('SELECT counter, last_used_at FROM passkeys WHERE id = ?').bind(credId).first<any>();
    expect(passkeyRow.counter).toBe(10);
    expect(passkeyRow.last_used_at).toBeTruthy();

    // Verify user last_login_at in DB
    const userRow = await env.DB.prepare('SELECT last_login_at FROM users WHERE id = ?').bind(userId).first<any>();
    expect(userRow.last_login_at).toBeTruthy();
  });

  it('two-step: password sign-in waits for a passkey; setting needs a passkey; last delete turns it off', async () => {
    const email = 'passkey-2fa@example.com';
    const userId = await createUser(email);
    const { access } = await login(email);
    const credId = 'cred-2fa';

    // Nothing to ask for yet.
    const refused = await call('/api/v1/auth/passkeys/2fa/', { method: 'PUT', token: access, body: { enabled: true } });
    expect(refused.status).toBe(409);

    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at)
       VALUES (?, ?, 'pubkey', 0, 'singleDevice', 0, 'Key', datetime('now'))`,
    )
      .bind(credId, userId)
      .run();
    const on = await call('/api/v1/auth/passkeys/2fa/', { method: 'PUT', token: access, body: { enabled: true } });
    expect(on.status).toBe(200);

    // Password alone no longer starts a session.
    const first = await call('/api/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(first.status).toBe(200);
    expect(sessionOf(first).access).toBe('');
    const pending = (await first.json()) as any;
    expect(pending.code).toBe('auth.passkeyRequired');
    expect(pending.options.allowCredentials.map((c: any) => c.id)).toEqual([credId]);

    // A first-step (discoverable) challenge cannot stand in for the second step.
    await env.KV.put('webauthn:chal:plain-auth', JSON.stringify({ challenge: 'c', type: 'auth' }));
    const wrongType = await call('/api/v1/auth/passkeys/2fa/verify/', {
      body: { challenge_id: 'plain-auth', response: { id: credId } },
    });
    expect(wrongType.status).toBe(400);

    // A failed answer spends the challenge.
    mockAuthVerifyThrows = new Error('bad signature');
    const bad = await call('/api/v1/auth/passkeys/2fa/verify/', {
      body: { challenge_id: pending.challenge_id, response: { id: credId } },
    });
    expect(bad.status).toBe(401);
    mockAuthVerifyThrows = null;
    const replay = await call('/api/v1/auth/passkeys/2fa/verify/', {
      body: { challenge_id: pending.challenge_id, response: { id: credId } },
    });
    expect(replay.status).toBe(400);

    // Another user's passkey does not satisfy it.
    const other = await createUser('passkey-2fa-other@example.com');
    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at)
       VALUES ('cred-2fa-other', ?, 'pubkey', 0, 'singleDevice', 0, 'Other', datetime('now'))`,
    )
      .bind(other)
      .run();
    const second = (await (await call('/api/v1/auth/login', { body: { email, password: PASSWORD } })).json()) as any;
    mockAuthVerifyResult = {
      verified: true,
      authenticationInfo: { newCounter: 1, credentialDeviceType: 'singleDevice', credentialBackedUp: false },
    };
    const foreign = await call('/api/v1/auth/passkeys/2fa/verify/', {
      body: { challenge_id: second.challenge_id, response: { id: 'cred-2fa-other' } },
    });
    expect(foreign.status).toBe(401);

    // The right passkey completes the sign-in.
    const third = (await (await call('/api/v1/auth/login', { body: { email, password: PASSWORD } })).json()) as any;
    const done = await call('/api/v1/auth/passkeys/2fa/verify/', {
      body: { challenge_id: third.challenge_id, response: { id: credId } },
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ code: 'auth.loginSuccess', user_id: userId });
    const session = sessionOf(done);
    expect(session.access).toBeTruthy();

    // Profile shows the setting; deleting the last passkey switches it off.
    const me = await call('/api/v1/auth/me', { token: session.access });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).passkey_2fa).toBe(true);
    const del = await call(`/api/v1/auth/passkeys/${credId}/`, { method: 'DELETE', token: session.access });
    expect(del.status).toBe(204);
    const row = await env.DB.prepare('SELECT passkey_2fa FROM users WHERE id = ?').bind(userId).first<any>();
    expect(row.passkey_2fa).toBe(0);
    expect(sessionOf(await call('/api/v1/auth/login', { body: { email, password: PASSWORD } })).access).toBeTruthy();
  });

  it('list/rename/delete are scoped to the owner, last-method guard enforced', async () => {
    const userA = 'passkey-usera@example.com';
    const userB = 'passkey-userb@example.com';
    const idA = await createUser(userA);
    const idB = await createUser(userB);

    const { access: accessA } = await login(userA);
    const { access: accessB } = await login(userB);

    // Insert passkeys for User A and User B
    const credA1 = 'cred-a-1';
    const credA2 = 'cred-a-2';
    const credB = 'cred-b-1';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at) VALUES (?, ?, 'pk', 0, 'singleDevice', 0, 'A Key 1', '2026-10-17T01:00:00Z')`,
      ).bind(credA1, idA),
      env.DB.prepare(
        `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at) VALUES (?, ?, 'pk', 0, 'singleDevice', 0, 'A Key 2', '2026-10-17T02:00:00Z')`,
      ).bind(credA2, idA),
      env.DB.prepare(
        `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at) VALUES (?, ?, 'pk', 0, 'singleDevice', 0, 'B Key 1', '2026-10-17T03:00:00Z')`,
      ).bind(credB, idB),
    ]);

    // List: User A sees only A's passkeys
    const listRes = await call('/api/v1/auth/passkeys/', { token: accessA });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as any[];
    expect(list.length).toBe(2);
    expect(list.map((p) => p.id)).toEqual([credA2, credA1]);

    // List: User B sees only B's passkeys
    const listBRes = await call('/api/v1/auth/passkeys/', { token: accessB });
    expect(listBRes.status).toBe(200);
    const listB = (await listBRes.json()) as any[];
    expect(listB.map((p) => p.id)).toEqual([credB]);

    // Rename: User A renames own passkey
    const renameRes = await call(`/api/v1/auth/passkeys/${credA1}/`, {
      method: 'PATCH',
      token: accessA,
      body: { name: 'Renamed Key 1' },
    });
    expect(renameRes.status).toBe(200);
    expect(await renameRes.json()).toEqual({ id: credA1, name: 'Renamed Key 1' });

    // Rename: User A cannot rename User B's passkey -> 404
    const renameOther = await call(`/api/v1/auth/passkeys/${credB}/`, {
      method: 'PATCH',
      token: accessA,
      body: { name: 'Hack' },
    });
    expect(renameOther.status).toBe(404);

    // Delete: User A cannot delete User B's passkey -> 404
    const deleteOther = await call(`/api/v1/auth/passkeys/${credB}/`, {
      method: 'DELETE',
      token: accessA,
    });
    expect(deleteOther.status).toBe(404);

    // Delete: User A has password, so deleting is allowed even if 1 remains
    const deleteA1 = await call(`/api/v1/auth/passkeys/${credA1}/`, {
      method: 'DELETE',
      token: accessA,
    });
    expect(deleteA1.status).toBe(204);

    // Now test last-method guard on a passwordless user with no googleId
    const userNoPass = 'passkey-nopass@example.com';
    const idNoPass = await createUser(userNoPass, { password: null });
    const credOnly = 'cred-only-method';
    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at) VALUES (?, ?, 'pk', 0, 'singleDevice', 0, 'Sole Key', '2026-10-17T01:00:00Z')`,
    )
      .bind(credOnly, idNoPass)
      .run();

    // Sign in by setting session tokens manually for test
    const { issueTokens } = await import('../../src/services/accounts/tokens');
    const tokens = await issueTokens(env, idNoPass);

    // Try deleting the only passkey
    const deleteLastRes = await call(`/api/v1/auth/passkeys/${credOnly}/`, {
      method: 'DELETE',
      token: tokens.access,
    });
    expect(deleteLastRes.status).toBe(409);
    expect(await deleteLastRes.json()).toEqual({ error: { code: 'acct.errLastSignInMethod' } });

    // Add a second passkey for idNoPass: deleting one is now allowed
    const credSecond = 'cred-second-method';
    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at) VALUES (?, ?, 'pk', 0, 'singleDevice', 0, 'Second Key', '2026-10-17T01:00:00Z')`,
    )
      .bind(credSecond, idNoPass)
      .run();

    const deleteOneOfTwo = await call(`/api/v1/auth/passkeys/${credSecond}/`, {
      method: 'DELETE',
      token: tokens.access,
    });
    expect(deleteOneOfTwo.status).toBe(204);
  });

  it('account deletion removes all passkeys for that user', async () => {
    const userEmail = 'passkey-del-acct@example.com';
    const userId = await createUser(userEmail);
    const { access } = await login(userEmail);

    const credId = 'cred-to-delete-on-account-deletion';
    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at)
       VALUES (?, ?, 'pk', 0, 'singleDevice', 0, 'Key', datetime('now'))`,
    )
      .bind(credId, userId)
      .run();

    // Delete account
    const delRes = await call('/api/v1/auth/me', {
      method: 'DELETE',
      token: access,
    });
    expect(delRes.status).toBe(204);

    // Verify passkey row was removed
    const row = await env.DB.prepare('SELECT id FROM passkeys WHERE id = ?').bind(credId).first();
    expect(row).toBeNull();
  });

  it('registration verify: derives default name from catalogue or deviceType/transports when name is omitted', async () => {
    const userEmail = 'passkey-default-names@example.com';
    await createUser(userEmail);
    const { access } = await login(userEmail);

    const originalAssetsFetch = env.ASSETS?.fetch;
    const mockCatalogue = {
      'known-aaguid-1': {
        name: 'YubiKey 5 NFC',
        light: 'known-aaguid-1.light.svg',
        dark: 'known-aaguid-1.dark.svg',
      },
    };
    (env as any).ASSETS = {
      fetch: vi.fn(async (url: URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString();
        if (u.includes('/passkey-icons/names.json')) {
          return new Response(JSON.stringify(mockCatalogue), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      }),
    };

    // 1. Matches catalogue -> name is catalogue name
    clearCatalogueCache();
    let optRes = await call('/api/v1/auth/passkeys/register/options/', { method: 'POST', token: access });
    let { challenge_id } = (await optRes.json()) as { challenge_id: string };

    mockRegVerifyResult = {
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: 'known-aaguid-1',
        credential: {
          id: 'cred-cat-name',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 1,
          transports: ['usb'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array([0]),
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://x',
      },
    };

    let verifyRes = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: {
        challenge_id,
        response: { id: 'cred-cat-name', response: { transports: ['usb'] } },
      },
    });
    expect(verifyRes.status).toBe(201);
    expect(await verifyRes.json()).toEqual({ id: 'cred-cat-name', name: 'YubiKey 5 NFC' });

    // 2. All-zero AAGUID (iCloud Keychain fallback) with multiDevice -> 'Passkey (synced)'
    optRes = await call('/api/v1/auth/passkeys/register/options/', { method: 'POST', token: access });
    challenge_id = ((await optRes.json()) as { challenge_id: string }).challenge_id;

    mockRegVerifyResult = {
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: {
          id: 'cred-icloud-fallback',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 1,
          transports: ['internal'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array([0]),
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: 'http://x',
      },
    };

    verifyRes = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: {
        challenge_id,
        response: { id: 'cred-icloud-fallback', response: { transports: ['internal'] } },
      },
    });
    expect(verifyRes.status).toBe(201);
    expect(await verifyRes.json()).toEqual({ id: 'cred-icloud-fallback', name: 'Passkey (synced)' });

    // 3. Unknown AAGUID with usb transport -> 'Security key'
    optRes = await call('/api/v1/auth/passkeys/register/options/', { method: 'POST', token: access });
    challenge_id = ((await optRes.json()) as { challenge_id: string }).challenge_id;

    mockRegVerifyResult = {
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: 'unknown-usb-aaguid',
        credential: {
          id: 'cred-security-key',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 1,
          transports: ['usb'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array([0]),
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://x',
      },
    };

    verifyRes = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: {
        challenge_id,
        response: { id: 'cred-security-key', response: { transports: ['usb'] } },
      },
    });
    expect(verifyRes.status).toBe(201);
    expect(await verifyRes.json()).toEqual({ id: 'cred-security-key', name: 'Security key' });

    // 4. Unknown AAGUID, singleDevice, internal transport -> 'Passkey'
    optRes = await call('/api/v1/auth/passkeys/register/options/', { method: 'POST', token: access });
    challenge_id = ((await optRes.json()) as { challenge_id: string }).challenge_id;

    mockRegVerifyResult = {
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: 'unknown-aaguid',
        credential: {
          id: 'cred-generic-passkey',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 1,
          transports: ['internal'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array([0]),
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://x',
      },
    };

    verifyRes = await call('/api/v1/auth/passkeys/register/verify/', {
      token: access,
      body: {
        challenge_id,
        response: { id: 'cred-generic-passkey', response: { transports: ['internal'] } },
      },
    });
    expect(verifyRes.status).toBe(201);
    expect(await verifyRes.json()).toEqual({ id: 'cred-generic-passkey', name: 'Passkey' });

    (env as any).ASSETS = { fetch: originalAssetsFetch };
  });

  it('list passkeys: returns aaguid, provider, icon_light, icon_dark from catalogue', async () => {
    const userEmail = 'passkey-list-cat@example.com';
    const userId = await createUser(userEmail);
    const { access } = await login(userEmail);

    const originalAssetsFetch = env.ASSETS?.fetch;
    const mockCatalogue = {
      'aaguid-123': {
        name: 'Bitwarden',
        light: 'aaguid-123.light.svg',
        dark: 'aaguid-123.dark.svg',
      },
    };
    (env as any).ASSETS = {
      fetch: vi.fn(
        async () => new Response(JSON.stringify(mockCatalogue), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    };
    clearCatalogueCache();

    const cred1 = 'cred-with-catalogue';
    const cred2 = 'cred-without-catalogue';

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, aaguid, created_at)
         VALUES (?, ?, 'pk', 0, 'singleDevice', 0, 'My Bitwarden', 'aaguid-123', '2026-10-17T02:00:00Z')`,
      ).bind(cred1, userId),
      env.DB.prepare(
        `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, aaguid, created_at)
         VALUES (?, ?, 'pk', 0, 'singleDevice', 0, 'Unknown Key', NULL, '2026-10-17T01:00:00Z')`,
      ).bind(cred2, userId),
    ]);

    const res = await call('/api/v1/auth/passkeys/', { token: access });
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list.length).toBe(2);

    // cred1 has catalogue match
    expect(list[0]).toMatchObject({
      id: cred1,
      name: 'My Bitwarden',
      aaguid: 'aaguid-123',
      provider: 'Bitwarden',
      icon_light: '/passkey-icons/aaguid-123.light.svg',
      icon_dark: '/passkey-icons/aaguid-123.dark.svg',
      device_type: 'singleDevice',
      backed_up: false,
    });

    // cred2 has no aaguid
    expect(list[1]).toMatchObject({
      id: cred2,
      name: 'Unknown Key',
      aaguid: null,
      provider: null,
      icon_light: null,
      icon_dark: null,
      device_type: 'singleDevice',
      backed_up: false,
    });

    (env as any).ASSETS = { fetch: originalAssetsFetch };
  });

  it('loadCatalogue: fetches names.json via ASSETS, caches result, and returns empty object on failure', async () => {
    clearCatalogueCache();
    const originalAssetsFetch = env.ASSETS?.fetch;

    // Successful load
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ a1: { name: 'A1', light: null, dark: null } }), { status: 200 }));
    (env as any).ASSETS = { fetch: fetchSpy };

    const first = await loadCatalogue(env as any);
    expect(first).toEqual({ a1: { name: 'A1', light: null, dark: null } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call should return cached without fetch
    const second = await loadCatalogue(env as any);
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // On failure
    clearCatalogueCache();
    (env as any).ASSETS = {
      fetch: vi.fn(async () => new Response('Error', { status: 500 })),
    };
    const failedRes = await loadCatalogue(env as any);
    expect(failedRes).toEqual({});

    // When ASSETS throws
    clearCatalogueCache();
    (env as any).ASSETS = {
      fetch: vi.fn(async () => {
        throw new Error('Network error');
      }),
    };
    const thrownRes = await loadCatalogue(env as any);
    expect(thrownRes).toEqual({});

    // When ASSETS is missing
    clearCatalogueCache();
    const noAssetsRes = await loadCatalogue({} as any);
    expect(noAssetsRes).toEqual({});

    (env as any).ASSETS = { fetch: originalAssetsFetch };
  });
});
