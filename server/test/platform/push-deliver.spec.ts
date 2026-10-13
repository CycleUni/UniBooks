import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { deliver } from '../../src/queues/push';

const URL_ = 'https://fcm.googleapis.com/v1/projects/p/messages:send';
const push = { title: 't', body: 'b', link: '/x' };
const devices = [
  { id: 1, token: 'a' },
  { id: 2, token: 'b' },
];

function answer(...statuses: number[]) {
  let i = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: statuses[i++ % statuses.length] }));
}

describe('push delivery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws (so the queue retries) when every device failed transiently', async () => {
    answer(503, 429);
    await expect(deliver(env, URL_, 'tok', devices, push)).rejects.toThrow();
  });

  it('does not retry once any device got it, so nobody sees the push twice', async () => {
    answer(200, 503);
    expect(await deliver(env, URL_, 'tok', devices, push)).toBe(1);
  });

  it('drops a rejected cached access token and retries', async () => {
    await env.KV.put('fcm_access_token', 'stale');
    answer(401);
    await expect(deliver(env, URL_, 'stale', devices, push)).rejects.toThrow();
    expect(await env.KV.get('fcm_access_token')).toBeNull();
  });

  it('acks a permanent rejection without retrying', async () => {
    answer(400);
    expect(await deliver(env, URL_, 'tok', devices, push)).toBe(0);
  });
});
