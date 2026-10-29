import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { handlePushQueue, supersededChatPushes } from '../../src/queues/push';
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

describe('chat pushes within one batch', () => {
  const chat = (recipient: string, room: string, timestamp: number) =>
    message({ type: 'chat_message', recipient_id: recipient, sender_id: 's', room_id: room, conversation_id: room, timestamp });

  it('sends only the newest per recipient and conversation', () => {
    const a1 = chat('u1', 'r1', 1);
    const a3 = chat('u1', 'r1', 3);
    const a2 = chat('u1', 'r1', 2);
    const otherRoom = chat('u1', 'r2', 1);
    const otherUser = chat('u2', 'r1', 1);
    const order = message({ type: 'order_update', user_id: 'u1', order_id: 'o1', status: 'accepted', book_title: 'Book' });
    const superseded = supersededChatPushes([a1, a3, a2, otherRoom, otherUser, order] as unknown as Message<PushMessage>[]);
    expect([...superseded]).toEqual(expect.arrayContaining([a1, a2]));
    expect(superseded.size).toBe(2);
  });

  it('acks the superseded ones without retrying', async () => {
    const first = chat('u1', 'r1', 1);
    const second = chat('u1', 'r1', 2);
    await handlePushQueue({ messages: [first, second] } as unknown as MessageBatch<PushMessage>, env);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
  });
});
