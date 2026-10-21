import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleEmailQueue } from '../../src/queues/email';
import { createDb, emailSent } from '../../src/db';
import type { EmailMessage } from '../../src/queues/types';

function message(id: string, attempts: number, body: EmailMessage) {
  return { id, attempts, body, ack: vi.fn(), retry: vi.fn(), timestamp: new Date() };
}

describe('email queue redelivery', () => {
  it('acks a redelivered message that was already sent, without building or sending it', async () => {
    const id = crypto.randomUUID();
    await createDb(env.DB).insert(emailSent).values({ messageId: id, sentAt: new Date().toISOString() }).run();
    // A body that would throw if it were processed.
    const m = message(id, 2, { type: 'no-such-type' } as unknown as EmailMessage);
    await handleEmailQueue({ messages: [m] } as unknown as MessageBatch<EmailMessage>, env);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });
});

describe('email queue failures', () => {
  const link: EmailMessage = {
    type: 'account_link',
    kind: 'passwordReset',
    user_id: 'u1',
    to: 'someone@example.com',
    name: '',
    lang: 'en',
    path: '/forgot-password?token=abc',
  };
  const withMailjet = { ...env, MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' } as typeof env;

  it('drops a message Mailjet rejects (4xx) and retries one it could not take (5xx, 429)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const [status, outcome] of [
        [400, 'ack'],
        [422, 'ack'],
        [429, 'retry'],
        [401, 'retry'],
        [503, 'retry'],
      ] as const) {
        fetchSpy.mockResolvedValueOnce(new Response('{}', { status }));
        const m = message(crypto.randomUUID(), 1, link);
        await handleEmailQueue({ messages: [m] } as unknown as MessageBatch<EmailMessage>, withMailjet);
        expect(outcome === 'ack' ? m.ack : m.retry, `status ${status}`).toHaveBeenCalledOnce();
        expect(outcome === 'ack' ? m.retry : m.ack, `status ${status}`).not.toHaveBeenCalled();
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('email queue dedupe keys', () => {
  it('sends a keyed notice once, however many times it is enqueued', async () => {
    const withMailjet = { ...env, MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' } as typeof env;
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, email, role, is_active, is_banned, created_at, updated_at) VALUES (?, ?, 'user', 1, 0, ?, ?)",
    )
      .bind(userId, `${userId.slice(0, 8)}@example.com`, new Date().toISOString(), new Date().toISOString())
      .run();
    const body = {
      type: 'meetup_reminder',
      dedupe_key: `meetup:o1:${userId}:2030-01-01T10:00:00.000Z`,
      user_id: userId,
      email: `${userId.slice(0, 8)}@example.com`,
      order_id: 'o1',
      book_title: 'Book',
      meetup_time: '2030-01-01T10:00:00.000Z',
      meetup_location: 'Library',
      region: 'TW',
    } as EmailMessage;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    try {
      const a = message(crypto.randomUUID(), 1, body);
      const b = message(crypto.randomUUID(), 1, body);
      await handleEmailQueue({ messages: [a] } as unknown as MessageBatch<EmailMessage>, withMailjet);
      await handleEmailQueue({ messages: [b] } as unknown as MessageBatch<EmailMessage>, withMailjet);
      expect(a.ack).toHaveBeenCalledOnce();
      expect(b.ack).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('mailjet')).length).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
