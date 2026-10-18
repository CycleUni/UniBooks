import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { applyAutoComplete, applyOrderUpdate, applyPlatformCancel } from '../services/orders/transitions';

/**
 * Per-listing mutex for order state changes — the Worker's row lock on
 * the listing and its order. One instance per key (`listing:<id>`, or
 * `order:<id>` for an order whose listing is gone; see
 * services/orders/lock.ts).
 *
 * A Durable Object lets other calls in while it awaits D1 (only its own
 * storage holds the input gate), so the transitions are chained explicitly:
 * each starts only after the previous one on this key has finished. The D1
 * writes themselves are conditional on the expected status as well
 * (services/orders/transitions.ts), so the lock is about giving the loser a
 * clean answer, not the only line of defence.
 *
 * The same class also serves the cron run lock: one
 * instance per job name, `cron:<name>`.
 */
export class OrderLock extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  updateOrder(args: Parameters<typeof applyOrderUpdate>[1]) {
    return this.exclusive(() => applyOrderUpdate(this.env, args));
  }

  platformCancel(args: Parameters<typeof applyPlatformCancel>[1]) {
    return this.exclusive(() => applyPlatformCancel(this.env, args));
  }

  autoComplete(args: Parameters<typeof applyAutoComplete>[1]) {
    return this.exclusive(() => applyAutoComplete(this.env, args));
  }

  /** Take the run lock unless a live one is held; it lapses after ttlMs. */
  async tryAcquire(ttlMs: number): Promise<boolean> {
    const until = (await this.ctx.storage.get<number>('until')) ?? 0;
    const now = Date.now();
    if (until > now) return false;
    await this.ctx.storage.put('until', now + ttlMs);
    return true;
  }

  async release(): Promise<void> {
    await this.ctx.storage.delete('until');
  }
}
