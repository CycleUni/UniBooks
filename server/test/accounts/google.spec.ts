import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { googleKeys } from '../../src/services/accounts/google';
import { call, createUser, seedReference, sessionOf } from './helpers';

const KID = 'test-kid';
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
    JSON.stringify({ iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, iat: now, exp: now + 600, ...claims }),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
  await seedReference();
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

describe('Google sign-in', () => {
  it('needs a credential', async () => {
    const res = await call('/api/v1/auth/google', { body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'auth.errMissingCredential' } });
  });

  it('refuses another audience, a forged signature and an unverified email', async () => {
    const wrongAud = await call('/api/v1/auth/google', {
      body: { credential: await idToken({ sub: 's1', email: 'a@example.com', email_verified: true, aud: 'someone-else' }) },
    });
    expect(wrongAud.status).toBe(401);
    const good = await idToken({ sub: 's1', email: 'a@example.com', email_verified: true });
    const forged = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect((await call('/api/v1/auth/google', { body: { credential: forged } })).status).toBe(401);

    await createUser('victim@example.com');
    const unverified = await call('/api/v1/auth/google', {
      body: { credential: await idToken({ sub: 's2', email: 'victim@example.com', email_verified: false }) },
    });
    expect(unverified.status).toBe(403);
    expect(await unverified.json()).toEqual({ error: { code: 'auth.errEmailNotVerified' } });
  });

  it('creates an account, then signs the same Google user back in and links by email', async () => {
    const res = await call('/api/v1/auth/google', {
      body: {
        credential: await idToken({
          sub: 's3',
          email: 'New.Google@Example.com',
          email_verified: 'true',
          given_name: 'G',
          family_name: 'User',
        }),
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ user: { is_verified: false } });
    const session = sessionOf(res);
    expect(session.access && session.refresh && body.user_id).toBeTruthy();
    expect(body.access).toBeUndefined(); // tokens never reach page script
    const row = await env.DB.prepare('SELECT email, google_id, password_hash, is_active FROM users WHERE id = ?')
      .bind(body.user_id)
      .first<any>();
    expect(row).toMatchObject({ email: 'new.google@example.com', google_id: 's3', password_hash: null, is_active: 1 });

    const existing = await createUser('linkme@ntu.edu.tw');
    const linked = await call('/api/v1/auth/google', {
      body: { credential: await idToken({ sub: 's4', email: 'linkme@ntu.edu.tw', email_verified: true }) },
      headers: { 'X-Region': 'TW' },
    });
    const lb = (await linked.json()) as any;
    expect(lb.user_id).toBe(existing);
    expect(lb.user.is_verified).toBe(true);
  });

  it('a Google sign-in with the campus account renews a lapsed verification', async () => {
    const id = await createUser('lapsed@ntu.edu.tw');
    await env.DB.prepare(
      `INSERT INTO region_verifications (user_id, region_code, school_id, edu_email, verified_at, expires_at, is_active, created_at)
       SELECT ?, 'TW', id, 'lapsed@ntu.edu.tw', '2020-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z', 1, '2020-01-01T00:00:00.000Z' FROM schools WHERE code = 'NTU'`,
    )
      .bind(id)
      .run();
    const res = await call('/api/v1/auth/google?region=TW', {
      body: { credential: await idToken({ sub: 's9', email: 'lapsed@ntu.edu.tw', email_verified: true }) },
    });
    expect(((await res.json()) as any).user.is_verified).toBe(true);
    const row = await env.DB.prepare('SELECT verified_at, last_reverified_at, expires_at FROM region_verifications WHERE user_id = ?')
      .bind(id)
      .first<{ verified_at: string; last_reverified_at: string | null; expires_at: string }>();
    expect(row!.verified_at).toBe('2020-01-01T00:00:00.000Z');
    expect(row!.last_reverified_at).not.toBeNull();
    expect(row!.expires_at > new Date().toISOString()).toBe(true);
  });

  it('claims a never-activated registration for the verified Google owner, dropping its password', async () => {
    expect((await call('/api/v1/auth/register', { body: { email: 'claim@example.com', password: 'Attacker-Pass-123!' } })).status).toBe(
      201,
    );
    const res = await call('/api/v1/auth/google', {
      body: { credential: await idToken({ sub: 's6', email: 'claim@example.com', email_verified: true }) },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT is_active, password_hash, google_id FROM users WHERE email = ?')
      .bind('claim@example.com')
      .first<any>();
    expect(row).toMatchObject({ is_active: 1, password_hash: null, google_id: 's6' });
  });

  it('refuses a different Google identity on an already-linked account', async () => {
    await call('/api/v1/auth/google', {
      body: { credential: await idToken({ sub: 's7', email: 'recycled@example.com', email_verified: true }) },
    });
    const other = await call('/api/v1/auth/google', {
      body: { credential: await idToken({ sub: 's8', email: 'recycled@example.com', email_verified: true }) },
    });
    expect(other.status).toBe(403);
  });

  it('does not get past a disabled account', async () => {
    await createUser('off@example.com', { active: false });
    const res = await call('/api/v1/auth/google', {
      body: { credential: await idToken({ sub: 's5', email: 'off@example.com', email_verified: true }) },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'auth.errAccountDisabled' } });
  });
});
