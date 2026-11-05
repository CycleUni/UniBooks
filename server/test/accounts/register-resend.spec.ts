import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { PASSWORD, call, createUser, seedReference } from './helpers';

beforeAll(async () => {
  await seedReference();
});

async function register(email: string) {
  const res = await call('/api/v1/auth/register', { body: { email, password: PASSWORD, first_name: 'P', last_name: 'U' } });
  expect(res.status).toBe(201);
  return (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>())!.id;
}

const liveLinks = (userId: string) =>
  env.DB.prepare(
    "SELECT COUNT(*) AS n FROM one_time_tokens WHERE user_id = ? AND purpose = 'register' AND used_at IS NULL AND expires_at > ?",
  )
    .bind(userId, new Date().toISOString())
    .first<{ n: number }>()
    .then((r) => r!.n);

const lapse = (userId: string) =>
  env.DB.prepare("UPDATE one_time_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").bind(userId).run();

const resend = (email: string, password = PASSWORD) => call('/api/v1/auth/register/resend', { body: { email, password } });

describe('resend activation', () => {
  it('replaces the link when the registration password is given', async () => {
    const id = await register('resend-ok@example.invalid');
    const res = await resend('resend-ok@example.invalid');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 'auth.activationResent' });
    expect(await liveLinks(id)).toBe(1);
    // The new link still carries the registration password.
    const login = await call('/api/v1/auth/login', { body: { email: 'resend-ok@example.invalid', password: PASSWORD } });
    expect(await login.json()).toEqual({ error: { code: 'auth.errAccountNotActivated' } });
  });

  it('answers a wrong password, an active account and an unknown address alike', async () => {
    await register('resend-wrong@example.invalid');
    await createUser('resend-active@example.invalid');
    for (const [email, password] of [
      ['resend-wrong@example.invalid', 'Wrong-password-1'],
      ['resend-active@example.invalid', PASSWORD],
      ['resend-nobody@example.invalid', PASSWORD],
    ]) {
      const res = await resend(email, password);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: 'auth.errInvalidCredentials' } });
    }
  });

  it('tells sign-in and resend to register again once every link has lapsed', async () => {
    const id = await register('resend-lapsed@example.invalid');
    await lapse(id);
    const login = await call('/api/v1/auth/login', { body: { email: 'resend-lapsed@example.invalid', password: PASSWORD } });
    expect(login.status).toBe(403);
    expect(await login.json()).toEqual({ error: { code: 'auth.errRegistrationExpired' } });
    const res = await resend('resend-lapsed@example.invalid');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'auth.errRegistrationExpired' } });
    // Registering again works and is the way back.
    await register('resend-lapsed@example.invalid');
    expect(await liveLinks(id)).toBe(1);
  });
});
