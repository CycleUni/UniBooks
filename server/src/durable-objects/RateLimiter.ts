import { DurableObject } from 'cloudflare:workers';

/**
 * Fixed-window request counter, one instance per (scope, client) key.
 * A Durable Object serialises calls, so the check-and-increment is atomic —
 * unlike a KV read-then-write, which any burst of parallel requests slips past.
 */
export class RateLimiter extends DurableObject {
  async hit(limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter: number }> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - (now % windowMs);
    const stored = (await this.ctx.storage.get<{ start: number; count: number }>('w')) ?? { start: windowStart, count: 0 };
    const state = stored.start === windowStart ? stored : { start: windowStart, count: 0 };
    if (state.count >= limit) {
      return { allowed: false, retryAfter: Math.ceil((windowStart + windowMs - now) / 1000) };
    }
    state.count += 1;
    await this.ctx.storage.put('w', state);
    // Let the instance's storage go once the window is over.
    await this.ctx.storage.setAlarm(windowStart + windowMs + 1000);
    return { allowed: true, retryAfter: 0 };
  }

  /** Whether the key is at its limit, without counting this call (retryAfter, or 0 when not limited). */
  async peek(limit: number, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - (now % windowMs);
    const stored = await this.ctx.storage.get<{ start: number; count: number }>('w');
    if (!stored || stored.start !== windowStart || stored.count < limit) return 0;
    return Math.ceil((windowStart + windowMs - now) / 1000);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
