import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import type { RateLimiter } from '../../src/durable-objects/RateLimiter';

const stub = (name: string) => {
  const ns = env.RATE_LIMITER as DurableObjectNamespace<RateLimiter>;
  return ns.get(ns.idFromName(name));
};

describe('RateLimiter', () => {
  it('counts hits up to the limit, then refuses with a retry-after', async () => {
    const s = stub(`hit:${crypto.randomUUID()}`);
    expect((await s.hit(2, 3600)).allowed).toBe(true);
    expect((await s.hit(2, 3600)).allowed).toBe(true);
    const third = await s.hit(2, 3600);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it('peek reports the limit without counting', async () => {
    const s = stub(`peek:${crypto.randomUUID()}`);
    expect(await s.peek(1, 3600)).toBe(0);
    expect(await s.peek(1, 3600)).toBe(0); // peeking used nothing up
    await s.hit(1, 3600);
    expect(await s.peek(1, 3600)).toBeGreaterThan(0);
  });
});
