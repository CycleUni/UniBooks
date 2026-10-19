import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import type { ChallengeStore } from '../../src/durable-objects/ChallengeStore';

const store = (id: string) => {
  const ns = env.CHALLENGE_STORE as DurableObjectNamespace<ChallengeStore>;
  return ns.get(ns.idFromName(id));
};

describe('ChallengeStore', () => {
  it('hands a challenge out once', async () => {
    const id = crypto.randomUUID();
    await store(id).put({ challenge: 'c', type: 'auth' }, 120);
    expect(await store(id).take()).toEqual({ challenge: 'c', type: 'auth' });
    expect(await store(id).take()).toBeNull();
  });

  it('does not hand out an expired challenge', async () => {
    const id = crypto.randomUUID();
    await store(id).put({ challenge: 'c', type: 'auth' }, -1);
    expect(await store(id).take()).toBeNull();
  });
});
