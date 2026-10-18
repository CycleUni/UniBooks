import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { verifyTurnstile } from '../../src/lib/turnstile';
import { call } from '../accounts/helpers';

describe('verifyTurnstile', () => {
  afterEach(() => vi.restoreAllMocks());
  const withSecret = { ...env, TURNSTILE_SECRET_KEY: 'secret' } as typeof env;

  it('passes only a token Cloudflare confirms', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ success: true }));
    expect(await verifyTurnstile(withSecret, 'tok', '203.0.113.9')).toBe(true);
    const body = fetchSpy.mock.calls[0][1]!.body as FormData;
    expect(body.get('secret')).toBe('secret');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('203.0.113.9');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
    expect(await verifyTurnstile(withSecret, 'tok')).toBe(false);
  });

  it('fails closed: no secret, no token, or the check itself failing', async () => {
    expect(await verifyTurnstile(env, 'tok')).toBe(false);
    expect(await verifyTurnstile(withSecret, '')).toBe(false);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('down'));
    expect(await verifyTurnstile(withSecret, 'tok')).toBe(false);
  });
});

describe('sign-in, registration and reset requests always ask for a challenge', () => {
  const mutable = env as unknown as Record<string, string>;
  afterEach(() => {
    vi.restoreAllMocks();
    mutable.TURNSTILE_SECRET_KEY = '';
    mutable.TURNSTILE_SITE_KEY = '';
  });

  const enable = () => {
    mutable.TURNSTILE_SECRET_KEY = 'secret';
    mutable.TURNSTILE_SITE_KEY = 'site';
  };
  const registerBody = { email: 'chal@example.com', password: 'Str0ng-passphrase-9', first_name: 'A', last_name: 'B' };

  it('asks for a token, with the site key, when none comes with the request', async () => {
    enable();
    for (const [path, body] of [
      ['/api/v1/auth/login', { email: 'chal@example.com', password: 'whatever-password-1' }],
      ['/api/v1/auth/register', registerBody],
      ['/api/v1/auth/password/reset/request', { email: 'chal@example.com' }],
    ] as const) {
      const res = await call(path, { body });
      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string; site_key: string } };
      expect(err.error.code).toBe('auth.errChallengeRequired');
      expect(err.error.site_key).toBe('site');
    }
  });

  it('refuses a token Cloudflare rejects, and lets a confirmed one through', async () => {
    enable();
    // Cloudflare confirms only the token 'good'.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      Response.json({ success: (init?.body as FormData).get('response') === 'good' }),
    );
    const bad = await call('/api/v1/auth/password/reset/request', { body: { email: 'chal@example.com', cf_turnstile_response: 'bad' } });
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('auth.errChallengeFailed');

    const ok = await call('/api/v1/auth/password/reset/request', { body: { email: 'chal@example.com', cf_turnstile_response: 'good' } });
    expect(ok.status).toBe(200);
  });
});
