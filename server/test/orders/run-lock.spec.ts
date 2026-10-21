import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { orderLock } from '../../src/services/orders/lock';

describe('cron run lock', () => {
  it('a run that outlived its ttl does not release the lock a later run holds', async () => {
    const lock = orderLock(env, `cron:test-${crypto.randomUUID()}`);
    const first = await lock.tryAcquire(1);
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    const second = await lock.tryAcquire(60_000); // the first one lapsed
    expect(second).toBeTruthy();
    await lock.release(first!); // the late first run finishing
    expect(await lock.tryAcquire(60_000)).toBeNull(); // still the second's
    await lock.release(second!);
    expect(await lock.tryAcquire(60_000)).toBeTruthy();
  });
});
