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
