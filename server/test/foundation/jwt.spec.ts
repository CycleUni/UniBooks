import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { signToken, verifyToken, InvalidTokenError } from '../../src/lib/jwt';

describe('typed tokens', () => {
  it('accepts a token only as its own type', async () => {
    const refresh = await signToken('refresh', { user_id: 'u1', jti: 'j1', family_id: 'f1' }, env.JWT_SIGNING_KEY);
    await expect(verifyToken('refresh', refresh, env.JWT_SIGNING_KEY)).resolves.toMatchObject({ user_id: 'u1' });
    await expect(verifyToken('access', refresh, env.JWT_SIGNING_KEY)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('refuses to sign or verify with a missing or short secret', async () => {
    await expect(signToken('access', { user_id: 'u1' }, 'short')).rejects.toThrow();
    const t = await signToken('access', { user_id: 'u1' }, env.JWT_SIGNING_KEY);
    await expect(verifyToken('access', t, undefined)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('test database', () => {
  it('has the migrated schema', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
    expect(results).toHaveLength(1);
  });
});
