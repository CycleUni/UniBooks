import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, createUser, login, seedReference } from './helpers';

beforeAll(async () => {
  await seedReference();
});

/** A verifier written out independently: it pins the wire format verifiers rely on. */
async function expectedSignature(userId: string, step: number): Promise<string> {
  const enc = new TextEncoder();
  const master = await crypto.subtle.importKey('raw', enc.encode(env.SECRET_KEY), 'HKDF', false, ['deriveKey']);
  const hmac = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('unibooks/member-token') },
    master,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, enc.encode(`${userId}:${step}`)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('GET /api/v1/auth/member-token', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await call('/api/v1/auth/member-token');
    expect(res.status).toBe(401);
  });

  it('signs <user id>.<time step> with the member-token key', async () => {
    const email = 'member-user@example.com';
    const userId = await createUser(email, { active: true });
    const session = await login(email);

    const before = Math.floor(Date.now() / 30_000);
    const res = await call('/api/v1/auth/member-token', { token: session.access });
    const after = Math.floor(Date.now() / 30_000);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { token: string; step_seconds: number; expires_in_ms: number };
    expect(data.step_seconds).toBe(30);
    expect(data.expires_in_ms).toBeGreaterThan(0);
    expect(data.expires_in_ms).toBeLessThanOrEqual(30_000);

    const [id, rawStep, sig, ...rest] = data.token.split('.');
    const step = Number(rawStep);
    expect(rest).toEqual([]);
    expect(id).toBe(userId);
    expect(step).toBeGreaterThanOrEqual(before);
    expect(step).toBeLessThanOrEqual(after);
    expect(sig).toBe(await expectedSignature(userId, step));
  });

  it('also accepts the __Host-ub_at cookie', async () => {
    const email = 'cookie-member-user@example.com';
    const userId = await createUser(email, { active: true });
    const session = await login(email);

    const res = await call('/api/v1/auth/member-token', {
      headers: { Cookie: `__Host-ub_at=${session.access}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string };
    expect(data.token.split('.')[0]).toBe(userId);
  });
});

describe('POST /api/v1/auth/member-token/verify', () => {
  const pass = async (email: string) => {
    const session = await login(email);
    const res = await call('/api/v1/auth/member-token', { token: session.access });
    return ((await res.json()) as { token: string }).token;
  };
  const verify = (token: string, staffToken: string) => call('/api/v1/auth/member-token/verify', { body: { token }, token: staffToken });

  it('is for staff only', async () => {
    await createUser('verify-member@example.com', { active: true });
    await createUser('verify-plain@example.com', { active: true });
    const code = await pass('verify-member@example.com');
    expect((await call('/api/v1/auth/member-token/verify', { body: { token: code } })).status).toBe(401);
    expect((await verify(code, (await login('verify-plain@example.com')).access)).status).toBe(403);
  });

  it('tells staff who holds the pass, without the full email', async () => {
    const id = await createUser('verify-holder@example.com', { active: true, first: 'Ada', last: 'Lee' });
    await createUser('verify-staff@example.com', { active: true, role: 'staff' });
    const staff = (await login('verify-staff@example.com')).access;

    const before = await verify(await pass('verify-holder@example.com'), staff);
    expect(before.status).toBe(200);
    const plain = (await before.json()) as Record<string, unknown>;
    expect(plain).toMatchObject({ user_id: id, email_masked: 'v***@example.com', is_verified: false, verified_regions: [] });
    expect(typeof plain.step).toBe('number');
    expect(JSON.stringify(plain)).not.toContain('verify-holder@');

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO region_verifications (user_id, region_code, school_id, edu_email, verified_at, is_active, created_at)
       VALUES (?, 'TW', 1, 'holder@ntu.edu.tw', ?, 1, ?)`,
    )
      .bind(id, now, now)
      .run();
    const after = (await (await verify(await pass('verify-holder@example.com'), staff)).json()) as Record<string, unknown>;
    expect(after).toMatchObject({ is_verified: true, verified_regions: ['TW'] });
  });

  it('refuses a forged, expired or malformed pass, and a banned holder', async () => {
    const id = await createUser('verify-banned@example.com', { active: true });
    await createUser('verify-staff2@example.com', { active: true, role: 'staff' });
    const staff = (await login('verify-staff2@example.com')).access;
    const code = await pass('verify-banned@example.com');
    const [, step, sig] = code.split('.');

    const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
    expect(await codeOf(await verify(`${id}.${step}.${'0'.repeat(32)}`, staff))).toBe('auth.errMemberTokenInvalid');
    expect(await codeOf(await verify(`${id}.${Number(step) - 3}.${sig}`, staff))).toBe('auth.errMemberTokenExpired');
    expect(await codeOf(await verify('not-a-pass', staff))).toBe('auth.errMemberTokenInvalid');

    await env.DB.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(id).run();
    const banned = await verify(code, staff);
    expect(banned.status).toBe(404);
    expect(await codeOf(banned)).toBe('auth.errMemberNotFound');
  });
});

describe('GET /api/v1/auth/members/:id', () => {
  it('lets staff look a member up by id, without the full email', async () => {
    const id = await createUser('lookup-member@example.com', { active: true, first: 'Bo', last: 'Wu' });
    await createUser('lookup-plain@example.com', { active: true });
    await createUser('lookup-staff@example.com', { active: true, role: 'staff' });
    const staff = (await login('lookup-staff@example.com')).access;

    expect((await call(`/api/v1/auth/members/${id}`)).status).toBe(401);
    expect((await call(`/api/v1/auth/members/${id}`, { token: (await login('lookup-plain@example.com')).access })).status).toBe(403);

    const res = await call(`/api/v1/auth/members/${id.toUpperCase()}`, { token: staff });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ user_id: id, email_masked: 'l***@example.com', is_verified: false });
    expect(JSON.stringify(body)).not.toContain('lookup-member@');
  });

  it('answers 404 for an unknown id, a malformed id, or a banned member', async () => {
    const id = await createUser('lookup-banned@example.com', { active: true });
    await createUser('lookup-staff2@example.com', { active: true, role: 'staff' });
    const staff = (await login('lookup-staff2@example.com')).access;
    await env.DB.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(id).run();
    for (const target of [id, crypto.randomUUID(), 'not-an-id']) {
      expect((await call(`/api/v1/auth/members/${target}`, { token: staff })).status).toBe(404);
    }
  });
});
