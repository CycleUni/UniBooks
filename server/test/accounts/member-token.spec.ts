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
