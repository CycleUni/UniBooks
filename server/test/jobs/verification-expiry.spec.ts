import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runVerificationExpiryReminder } from '../../src/jobs/index';
import { buildEmail } from '../../src/queues/email';
import { siteOrigin } from '../../src/lib/origin';
import type { EmailMessage } from '../../src/queues/types';
import { createUser, seedReference } from '../accounts/helpers';

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

beforeAll(async () => {
  await seedReference();
});

async function verified(email: string, expiresAt: string, edu: string | null = email) {
  const id = await createUser(email);
  await env.DB.prepare(
    `INSERT INTO region_verifications (user_id, region_code, school_id, edu_email, verified_at, expires_at, is_active, created_at)
     VALUES (?, 'TW', 1, ?, '2024-01-01T00:00:00.000Z', ?, 1, '2024-01-01T00:00:00.000Z')`,
  )
    .bind(id, edu, expiresAt)
    .run();
  return id;
}

function recorder() {
  const sent: EmailMessage[] = [];
  const jobEnv = { ...env, EMAIL_QUEUE: { send: async (m: EmailMessage) => void sent.push(m) } } as unknown as typeof env;
  return { sent, jobEnv };
}

describe('verification expiry reminder', () => {
  it('mails once per expiry, only within 30 days and only while live', async () => {
    const soon = await verified('soon@ntu.edu.tw', inDays(10));
    const later = await verified('later@ntu.edu.tw', inDays(60));
    const lapsed = await verified('gone@ntu.edu.tw', inDays(-1));
    const banned = await verified('banned@ntu.edu.tw', inDays(5));
    await env.DB.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(banned).run();

    const { sent, jobEnv } = recorder();
    await runVerificationExpiryReminder(jobEnv);
    const to = sent.map((m) => (m as { user_id: string }).user_id);
    expect(to).toContain(soon);
    expect(to).not.toContain(later);
    expect(to).not.toContain(lapsed);
    expect(to).not.toContain(banned);

    // A second run sends nothing new for the same expiry.
    const again = recorder();
    await runVerificationExpiryReminder(again.jobEnv);
    expect(again.sent.map((m) => (m as { user_id: string }).user_id)).not.toContain(soon);

    // Renewed, then near its new expiry: reminded again.
    await env.DB.prepare('UPDATE region_verifications SET expires_at = ? WHERE user_id = ?').bind(inDays(20), soon).run();
    const next = recorder();
    await runVerificationExpiryReminder(next.jobEnv);
    expect(next.sent.map((m) => (m as { user_id: string }).user_id)).toContain(soon);
  });

  it('a failed enqueue leaves it due for the next run', async () => {
    const id = await verified('retry@ntu.edu.tw', inDays(3));
    const failing = { ...env, EMAIL_QUEUE: { send: async () => Promise.reject(new Error('down')) } } as unknown as typeof env;
    await runVerificationExpiryReminder(failing);
    const { sent, jobEnv } = recorder();
    await runVerificationExpiryReminder(jobEnv);
    expect(sent.map((m) => (m as { user_id: string }).user_id)).toContain(id);
  });

  it('renders formally in the region language with the date, the address and the settings link', async () => {
    const id = await createUser('render@example.com');
    const msg = (user_id: string): EmailMessage => ({
      type: 'verification_expiry',
      user_id,
      region: 'TW',
      edu_email: 'r@ntu.edu.tw',
      expires_at: '2028-03-01T20:00:00.000Z',
    });
    const mail = await buildEmail(msg(id), env);
    expect(mail?.to).toBe('render@example.com');
    // 20:00 UTC is the next day in Taipei.
    expect(mail?.subject).toBe('UniBooks 學生身分驗證將於 2028-03-02 到期');
    expect(mail?.text).toContain('您於 UniBooks 以 r@ntu.edu.tw 完成的學生身分驗證');
    expect(mail?.text).toContain(siteOrigin(env) + '/account/settings');
    // Not a campus sign-in: a Google sign-in would not renew it, so it is not offered.
    expect(mail?.text).not.toContain('Google');

    // Google is offered only to a Google-linked account signing in with the bound campus address.
    const campus = await createUser('r@ntu.edu.tw');
    expect((await buildEmail(msg(campus), env))?.text).not.toContain('Google');
    await env.DB.prepare("UPDATE users SET google_id = 'g-r' WHERE id = ?").bind(campus).run();
    expect((await buildEmail(msg(campus), env))?.text).toContain('以學校 Google 帳號登入 UniBooks');
    const otherCampus = await createUser('other@ntu.edu.tw');
    await env.DB.prepare("UPDATE users SET google_id = 'g-o' WHERE id = ?").bind(otherCampus).run();
    expect((await buildEmail(msg(otherCampus), env))?.text).not.toContain('Google');
  });
});
