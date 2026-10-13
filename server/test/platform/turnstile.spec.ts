import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { verifyTurnstile } from '../../src/lib/turnstile';

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
