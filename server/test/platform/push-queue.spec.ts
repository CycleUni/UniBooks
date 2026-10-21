import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { handlePushQueue } from '../../src/queues/push';
import type { PushMessage } from '../../src/queues/types';

function message(body: PushMessage) {
  return { id: crypto.randomUUID(), attempts: 1, body, ack: vi.fn(), retry: vi.fn(), timestamp: new Date() };
}

describe('push queue dedupe keys', () => {
  it('records a keyed reminder once sent and turns the same key away after that', async () => {
    const key = `meetup:o1:u1:${crypto.randomUUID()}`;
    const body: PushMessage = {
      type: 'meetup_reminder',
      dedupe_key: key,
      user_id: 'u1',
      order_id: 'o1',
      book_title: 'Book',
      meetup_time: '2030-01-01T10:00:00.000Z',
    };
    const first = message(body);
    await handlePushQueue({ messages: [first] } as unknown as MessageBatch<PushMessage>, env);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare('SELECT key FROM push_sent WHERE key = ?').bind(key).first()).toBeTruthy();

    const again = message(body);
    await handlePushQueue({ messages: [again] } as unknown as MessageBatch<PushMessage>, env);
    expect(again.ack).toHaveBeenCalledOnce();
    expect(again.retry).not.toHaveBeenCalled();
  });

  it('records nothing for an unkeyed message', async () => {
    const before = (await env.DB.prepare('SELECT count(*) AS n FROM push_sent').first<{ n: number }>())!.n;
    const m = message({ type: 'order_update', user_id: 'u1', order_id: 'o1', status: 'accepted', book_title: 'Book' });
    await handlePushQueue({ messages: [m] } as unknown as MessageBatch<PushMessage>, env);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM push_sent').first<{ n: number }>())!.n).toBe(before);
  });
});
