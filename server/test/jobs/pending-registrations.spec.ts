import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runCleanup } from '../../src/jobs/index';
import { REGISTER, issue, PENDING_REGISTRATION_TTL_MS } from '../../src/services/accounts/oneTimeTokens';
import { createUser, seedReference } from '../accounts/helpers';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;

beforeAll(async () => {
  await seedReference();
});

async function pending(email: string, updatedAt: string) {
  const id = await createUser(email, { active: false, password: null });
  await env.DB.prepare('UPDATE users SET updated_at = ? WHERE id = ?').bind(updatedAt, id).run();
  return id;
}

const exists = async (id: string) => !!(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(id).first());

describe('pending registration purge', () => {
  it('deletes only never-activated registrations older than the grace period', async () => {
    const stale = await pending('stale@example.invalid', ago(PENDING_REGISTRATION_TTL_MS + DAY));
    await issue(env, REGISTER, stale, 86400, { password_hash: 'x' });
    const fresh = await pending('fresh@example.invalid', ago(DAY));
    const banned = await pending('banned@example.invalid', ago(30 * DAY));
    await env.DB.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(banned).run();
    const disabled = await pending('disabled@example.invalid', ago(30 * DAY));
    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(ago(40 * DAY), disabled)
      .run();
    const google = await createUser('g@example.invalid', { active: false, password: null, googleId: 'sub-1' });
    await env.DB.prepare('UPDATE users SET updated_at = ? WHERE id = ?')
      .bind(ago(30 * DAY), google)
      .run();
    const active = await createUser('active@example.invalid');
    await env.DB.prepare('UPDATE users SET updated_at = ? WHERE id = ?')
      .bind(ago(30 * DAY), active)
      .run();

    const result = await runCleanup(env);

    expect(result.pending_accounts_purged).toBeGreaterThanOrEqual(1);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(banned)).toBe(true);
    expect(await exists(disabled)).toBe(true);
    expect(await exists(google)).toBe(true);
    expect(await exists(active)).toBe(true);
  });
});
