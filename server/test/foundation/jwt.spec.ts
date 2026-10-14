import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { signToken, verifyToken, InvalidTokenError } from '../../src/lib/jwt';

describe('typed tokens', () => {
  it('accepts a token only as its own type', async () => {
    const refresh = await signToken('refresh', { user_id: 'u1', jti: 'j1', family_id: 'f1' }, env);
    await expect(verifyToken('refresh', refresh, env)).resolves.toMatchObject({ user_id: 'u1' });
    await expect(verifyToken('access', refresh, env)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('refuses to sign or verify with a missing or short secret', async () => {
    await expect(signToken('access', { user_id: 'u1' }, { SECRET_KEY: 'short' })).rejects.toThrow();
    const t = await signToken('access', { user_id: 'u1' }, env);
    await expect(verifyToken('access', t, {})).rejects.toThrow();
  });

  it('rejects a token signed under another SECRET_KEY (rotation signs everyone out)', async () => {
    const t = await signToken('access', { user_id: 'u1' }, { SECRET_KEY: 'another-secret-key-at-least-32-characters' });
    await expect(verifyToken('access', t, env)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('test database', () => {
  it('has the migrated schema', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
    expect(results).toHaveLength(1);
  });
});
