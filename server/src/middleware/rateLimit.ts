import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import type { RateLimiter } from '../durable-objects/RateLimiter';

/**
 * Scoped rate limit. Rates look like '5/min', '10/hour'.
 * Keyed by user id when signed in, else by CF-Connecting-IP (set by
 * Cloudflare and not forgeable by the client; no X-Forwarded-For fallback).
 */
const UNITS: Record<string, number> = { sec: 1, min: 60, hour: 3600, day: 86400 };

export function parseRate(rate: string): { limit: number; window: number } {
  const [n, unit] = rate.split('/');
  const window = UNITS[unit];
  if (!window || !Number(n)) throw new Error(`bad rate ${rate}`);
  return { limit: Number(n), window };
}

function limiter(c: Context<AppEnv>, scope: string, key?: string) {
  const who = key ?? c.get('userId') ?? c.req.header('CF-Connecting-IP') ?? 'local';
  const ns = c.env.RATE_LIMITER as DurableObjectNamespace<RateLimiter>;
  return ns.get(ns.idFromName(`${scope}:${who}`));
}

async function throttled(retryAfter: number): Promise<never> {
  const { HTTPException } = await import('hono/http-exception');
  throw new HTTPException(429, {
    res: Response.json(
      { detail: `Request was throttled. Expected available in ${retryAfter} seconds.`, error: { code: 'common.errThrottled' } },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    ),
  });
}

/** Count this request; false when the key is over its limit. */
export async function takeRate(c: Context<AppEnv>, scope: string, rate: string, key?: string): Promise<boolean> {
  if (c.env.ENVIRONMENT === 'test') return true;
  const { limit, window } = parseRate(rate);
  return (await limiter(c, scope, key).hit(limit, window)).allowed;
}

/** Count this request; 429 when the key is over its limit. */
export async function checkRate(c: Context<AppEnv>, scope: string, rate: string, key?: string): Promise<void> {
  if (c.env.ENVIRONMENT === 'test') return;
  const { limit, window } = parseRate(rate);
  const { allowed, retryAfter } = await limiter(c, scope, key).hit(limit, window);
  if (!allowed) await throttled(retryAfter);
}

/**
 * For limits that count only some outcomes (failed sign-ins): `assertUnder`
 * refuses once the key is at its limit without counting, and `count` records
 * one outcome after the fact.
 */
export function outcomeLimit(c: Context<AppEnv>, scope: string, rate: string, key: string) {
  const { limit, window } = parseRate(rate);
  const off = c.env.ENVIRONMENT === 'test';
  return {
    async assertUnder(): Promise<void> {
      if (off) return;
      const retryAfter = await limiter(c, scope, key).peek(limit, window);
      if (retryAfter) await throttled(retryAfter);
    },
    async count(): Promise<void> {
      if (!off) await limiter(c, scope, key).hit(limit, window);
    },
  };
}

/** Middleware form: `rateLimit('login', '5/min')`. */
export const rateLimit =
  (scope: string, rate: string, keyFn?: (c: Context<AppEnv>) => string | undefined): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    await checkRate(c, scope, rate, keyFn?.(c));
    await next();
  };
