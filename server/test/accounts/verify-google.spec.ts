import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { googleKeys } from '../../src/services/accounts/google';
import { call, createUser, login, seedReference, sessionOf } from './helpers';

const KID = 'test-kid-verify';
let privateKey: CryptoKey;
const originalFetch = googleKeys.fetchJwks;

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function idToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: env.GOOGLE_CLIENT_ID,
      iat: now,
      exp: now + 600,
      ...claims,
    }),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
  await seedReference();
  // Ensure a school with google_domains exists
  await env.DB.prepare(
    `INSERT OR REPLACE INTO schools (id, region_code, code, name, email_domain, email_domains, student_email_domain, google_domains, is_active, created_at)
     VALUES (10, 'TW', 'NTU_TEST', 'NTU Test Campus', 'ntu-test.edu.tw', '["gm.ntu-test.edu.tw"]', 'gm.ntu-test.edu.tw', '["gm.ntu-test.edu.tw"]', 1, datetime('now'))`,
  ).run();

  // A school with no google_domains
  await env.DB.prepare(
    `INSERT OR REPLACE INTO schools (id, region_code, code, name, email_domain, email_domains, student_email_domain, google_domains, is_active, created_at)
     VALUES (11, 'TW', 'NO_GOOGLE', 'No Google Uni', 'no-google.edu.tw', '[]', '', '[]', 1, datetime('now'))`,
  ).run();

  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  googleKeys.fetchJwks = async () => ({ keys: [{ ...jwk, kid: KID }] });
});

afterAll(() => {
  googleKeys.fetchJwks = originalFetch;
});

describe('Campus Google verification (POST /verify/google)', () => {
  it('requires authentication for options and verify endpoints', async () => {
    const optRes = await call('/api/v1/auth/verify/google/options');
    expect(optRes.status).toBe(401);

    const verRes = await call('/api/v1/auth/verify/google', { body: { credential: 'xyz' } });
    expect(verRes.status).toBe(401);
  });

  it('issues a single-use nonce via GET and POST options', async () => {
    await createUser('student1@gmail.com');
    const { access } = await login('student1@gmail.com');

    const getRes = await call('/api/v1/auth/verify/google/options', { token: access });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as any;
    expect(typeof getBody.nonce).toBe('string');
    expect(getBody.nonce.length).toBeGreaterThan(10);

    const postRes = await call('/api/v1/auth/verify/google/options', { method: 'POST', token: access });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as any;
    expect(typeof postBody.nonce).toBe('string');
  });

  it('works via /api/v1/auth/verify/google and /options as well', async () => {
    await createUser('student-alias@gmail.com');
    const { access } = await login('student-alias@gmail.com');

    const optRes = await call('/api/v1/auth/verify/google/options', { token: access });
    expect(optRes.status).toBe(200);
    const { nonce } = (await optRes.json()) as any;

    const token = await idToken({
      sub: 'alias-sub-1',
      email: 'student@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      nonce,
    });
    const verRes = await call('/api/v1/auth/verify/google', {
      body: { credential: token },
      token: access,
    });
    expect(verRes.status).toBe(200);
    expect(await verRes.json()).toEqual({
      code: 'acct.verifySuccess',
      edu_email: 'student@gm.ntu-test.edu.tw',
    });
  });

  it('refuses missing credential, missing nonce, invalid nonce, or replayed nonce', async () => {
    await createUser('student2@gmail.com');
    const { access } = await login('student2@gmail.com');

    // Missing credential
    const r1 = await call('/api/v1/auth/verify/google', { body: {}, token: access });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: { code: 'auth.errMissingCredential' } });

    // Missing nonce
    const noNonce = await idToken({
      sub: 's-no-nonce',
      email: 's2@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
    });
    const r2 = await call('/api/v1/auth/verify/google', { body: { credential: noNonce }, token: access });
    expect(r2.status).toBe(400);
    expect(await r2.json()).toEqual({ error: { code: 'auth.errInvalidToken' } });

    // Unknown/invalid nonce
    const badNonce = await idToken({
      sub: 's-bad-nonce',
      email: 's2@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      nonce: 'unknown-nonce-12345',
    });
    const r3 = await call('/api/v1/auth/verify/google', { body: { credential: badNonce }, token: access });
    expect(r3.status).toBe(400);
    expect(await r3.json()).toEqual({ error: { code: 'auth.errInvalidToken' } });

    // Nonce issued for another user
    await createUser('student3@gmail.com');
    const { access: access3 } = await login('student3@gmail.com');
    const optOther = (await (await call('/api/v1/auth/verify/google/options', { token: access3 })).json()) as any;

    const crossNonce = await idToken({
      sub: 's-cross-nonce',
      email: 's2@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      nonce: optOther.nonce,
    });
    const r4 = await call('/api/v1/auth/verify/google', { body: { credential: crossNonce }, token: access });
    expect(r4.status).toBe(400);
    expect(await r4.json()).toEqual({ error: { code: 'auth.errInvalidToken' } });

    // Valid nonce consumed, then replayed
    const optSelf = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const replayToken = await idToken({
      sub: 's-replay-sub',
      email: 's2@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      nonce: optSelf.nonce,
    });
    const rSuccess = await call('/api/v1/auth/verify/google', { body: { credential: replayToken }, token: access });
    expect(rSuccess.status).toBe(200);

    // Replay attempt with same token
    const rReplay = await call('/api/v1/auth/verify/google', { body: { credential: replayToken }, token: access });
    expect(rReplay.status).toBe(400);
    expect(await rReplay.json()).toEqual({ error: { code: 'auth.errInvalidToken' } });
  });

  it('refuses unverified email, non-campus email, and unsupported school', async () => {
    await createUser('student4@gmail.com');
    const { access } = await login('student4@gmail.com');

    // Unverified email
    const opt1 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const unverifiedToken = await idToken({
      sub: 's-unverified',
      email: 's4@gm.ntu-test.edu.tw',
      email_verified: false,
      hd: 'gm.ntu-test.edu.tw',
      nonce: opt1.nonce,
    });
    const r1 = await call('/api/v1/auth/verify/google', { body: { credential: unverifiedToken }, token: access });
    expect(r1.status).toBe(403);
    expect(await r1.json()).toEqual({ error: { code: 'auth.errEmailNotVerified' } });

    // Non-campus email (e.g. consumer @gmail.com)
    const opt2 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const consumerToken = await idToken({
      sub: 's-consumer',
      email: 'someone@gmail.com',
      email_verified: true,
      hd: 'gmail.com',
      nonce: opt2.nonce,
    });
    const r2 = await call('/api/v1/auth/verify/google', { body: { credential: consumerToken }, token: access });
    expect(r2.status).toBe(400);
    expect(await r2.json()).toEqual({ error: { code: 'acct.errEduEmail' } });

    // Unsupported school (unknown campus domain)
    const opt3 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const unknownSchoolToken = await idToken({
      sub: 's-unknown',
      email: 'someone@unknown-uni.edu.tw',
      email_verified: true,
      hd: 'unknown-uni.edu.tw',
      nonce: opt3.nonce,
    });
    const r3 = await call('/api/v1/auth/verify/google', { body: { credential: unknownSchoolToken }, token: access });
    expect(r3.status).toBe(400);
    expect(await r3.json()).toEqual({ error: { code: 'acct.errSchoolNotSupported' } });
  });

  it('refuses domain not marked as google_domain, missing hd, or mismatched hd', async () => {
    await createUser('student5@gmail.com');
    const { access } = await login('student5@gmail.com');

    // School has no google_domains: consumer Google account on non-Google campus mailbox
    const opt1 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const nonGoogleDomainToken = await idToken({
      sub: 's-nongoogle',
      email: 'student@no-google.edu.tw',
      email_verified: true,
      hd: 'no-google.edu.tw',
      nonce: opt1.nonce,
    });
    const r1 = await call('/api/v1/auth/verify/google', { body: { credential: nonGoogleDomainToken }, token: access });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: { code: 'acct.errNotCampusGoogle' } });

    // Missing hd claim
    const opt2 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const noHdToken = await idToken({
      sub: 's-nohd',
      email: 'student@gm.ntu-test.edu.tw',
      email_verified: true,
      nonce: opt2.nonce,
    });
    const r2 = await call('/api/v1/auth/verify/google', { body: { credential: noHdToken }, token: access });
    expect(r2.status).toBe(400);
    expect(await r2.json()).toEqual({ error: { code: 'acct.errNotCampusGoogle' } });

    // Mismatched hd claim (unrelated domain)
    const opt3 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const badHdToken = await idToken({
      sub: 's-badhd',
      email: 'student@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'evil.com',
      nonce: opt3.nonce,
    });
    const r3 = await call('/api/v1/auth/verify/google', { body: { credential: badHdToken }, token: access });
    expect(r3.status).toBe(400);
    expect(await r3.json()).toEqual({ error: { code: 'acct.errNotCampusGoogle' } });

    // Valid hd matching parent school domain (email: student@gm.ntu-test.edu.tw, hd: ntu-test.edu.tw)
    const opt4 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const parentHdToken = await idToken({
      sub: 's-parenthd',
      email: 'student5@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'ntu-test.edu.tw',
      nonce: opt4.nonce,
    });
    const r4 = await call('/api/v1/auth/verify/google', { body: { credential: parentHdToken }, token: access });
    expect(r4.status).toBe(200);
    expect(await r4.json()).toEqual({ code: 'acct.verifySuccess', edu_email: 'student5@gm.ntu-test.edu.tw' });
  });

  it('refuses sub or email already used by another user, but verifies for same user', async () => {
    const victimSub = 'victim-google-sub-99';
    await createUser('victim@example.com', { googleId: victimSub });

    const ownerEmail = 'taken-edu@gm.ntu-test.edu.tw';
    const otherUser = await createUser('other@example.com');
    await env.DB.prepare(
      `INSERT INTO region_verifications (user_id, region_code, school_id, edu_email, verified_at, expires_at, is_active, created_at)
       VALUES (?, 'TW', 10, ?, datetime('now'), datetime('now', '+2 years'), 1, datetime('now'))`,
    )
      .bind(otherUser, ownerEmail)
      .run();

    await createUser('student6@gmail.com');
    const { access } = await login('student6@gmail.com');

    // Sub linked to other user
    const opt1 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const subTakenToken = await idToken({
      sub: victimSub,
      email: 'fresh@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      nonce: opt1.nonce,
    });
    const r1 = await call('/api/v1/auth/verify/google', { body: { credential: subTakenToken }, token: access });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: { code: 'acct.errEmailTaken' } });

    // Email already used in region_verifications by otherUser
    const opt2 = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;
    const emailTakenToken = await idToken({
      sub: 's-random-sub-123',
      email: ownerEmail,
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      nonce: opt2.nonce,
    });
    const r2 = await call('/api/v1/auth/verify/google', { body: { credential: emailTakenToken }, token: access });
    expect(r2.status).toBe(400);
    expect(await r2.json()).toEqual({ error: { code: 'acct.errEmailTaken' } });

    // Same user: own linked Google identity verifies successfully
    const selfSub = 'self-google-sub-77';
    await createUser('student7@gmail.com', { googleId: selfSub });
    const { access: access7 } = await login('student7@gmail.com');
    const opt3 = (await (await call('/api/v1/auth/verify/google/options', { token: access7 })).json()) as any;
    const selfToken = await idToken({
      sub: selfSub,
      email: 'student7@gm.ntu-test.edu.tw',
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      nonce: opt3.nonce,
    });
    const r3 = await call('/api/v1/auth/verify/google', { body: { credential: selfToken }, token: access7 });
    expect(r3.status).toBe(200);
    expect(await r3.json()).toEqual({ code: 'acct.verifySuccess', edu_email: 'student7@gm.ntu-test.edu.tw' });
  });

  it('keeps users.google_id, users.email, avatar, name, session byte-identical and sets no session', async () => {
    const personalSub = 'personal-google-id-888';
    const userId = await createUser('personal.account@gmail.com', {
      googleId: personalSub,
      first: 'Alice',
      last: 'Wong',
    });
    // Set an avatar
    await env.DB.prepare("UPDATE users SET avatar_url = 'https://example.com/avatar.png' WHERE id = ?").bind(userId).run();

    const userBefore = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<any>();
    expect(userBefore.google_id).toBe(personalSub);
    expect(userBefore.email).toBe('personal.account@gmail.com');
    expect(userBefore.avatar_url).toBe('https://example.com/avatar.png');

    const { access } = await login('personal.account@gmail.com');
    const opt = (await (await call('/api/v1/auth/verify/google/options', { token: access })).json()) as any;

    const campusSub = 'campus-google-sub-999';
    const campusEmail = 'alice.wong@gm.ntu-test.edu.tw';
    const campusToken = await idToken({
      sub: campusSub,
      email: campusEmail,
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      given_name: 'CampusAlice',
      family_name: 'CampusWong',
      picture: 'https://google.com/campus-photo.jpg',
      nonce: opt.nonce,
    });

    const verifyRes = await call('/api/v1/auth/verify/google', {
      body: { credential: campusToken },
      token: access,
    });
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toEqual({
      code: 'acct.verifySuccess',
      edu_email: campusEmail,
    });

    // It must NEVER set a session cookie
    const session = sessionOf(verifyRes);
    expect(session.access).toBe('');
    expect(session.refresh).toBe('');

    // Check users table row: byte-identical before and after!
    const userAfter = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<any>();
    expect(userAfter.google_id).toBe(userBefore.google_id);
    expect(userAfter.email).toBe(userBefore.email);
    expect(userAfter.avatar_url).toBe(userBefore.avatar_url);
    expect(userAfter.name).toBe(userBefore.name);
    expect(userAfter.first_name).toBe(userBefore.first_name);
    expect(userAfter.last_name).toBe(userBefore.last_name);
    expect(userAfter.password_hash).toBe(userBefore.password_hash);
    expect(userAfter.role).toBe(userBefore.role);
    expect(userAfter.is_active).toBe(userBefore.is_active);

    // Region verification was created
    const verRow = await env.DB.prepare(
      'SELECT edu_email, school_id, is_active FROM region_verifications WHERE user_id = ? AND region_code = ?',
    )
      .bind(userId, 'TW')
      .first<any>();
    expect(verRow).toMatchObject({
      edu_email: campusEmail,
      school_id: 10,
      is_active: 1,
    });
  });

  it('confirms POST /accounts/google sign-in automatic campus verification works with google_domains', async () => {
    const campusEmail = 'autoverify.student@gm.ntu-test.edu.tw';
    const token = await idToken({
      sub: 'google-login-sub-campus',
      email: campusEmail,
      email_verified: true,
      hd: 'gm.ntu-test.edu.tw',
      given_name: 'Auto',
      family_name: 'Student',
    });

    const res = await call('/api/v1/auth/google', {
      body: { credential: token },
      headers: { 'X-Region': 'TW' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.user.is_verified).toBe(true);

    const verRow = await env.DB.prepare('SELECT edu_email, school_id, is_active FROM region_verifications WHERE user_id = ?')
      .bind(body.user_id)
      .first<any>();
    expect(verRow).toMatchObject({
      edu_email: campusEmail,
      school_id: 10,
      is_active: 1,
    });
  });
});
