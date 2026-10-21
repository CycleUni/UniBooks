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
