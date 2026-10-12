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

export async function checkRate(c: Context<AppEnv>, scope: string, rate: string, key?: string): Promise<void> {
  if (c.env.ENVIRONMENT === 'test') return;
  const { limit, window } = parseRate(rate);
  const who = key ?? c.get('userId') ?? c.req.header('CF-Connecting-IP') ?? 'local';
  const ns = c.env.RATE_LIMITER as DurableObjectNamespace<RateLimiter>;
  const stub = ns.get(ns.idFromName(`${scope}:${who}`));
  const { allowed, retryAfter } = await stub.hit(limit, window);
  if (!allowed) {
    const { HTTPException } = await import('hono/http-exception');
    throw new HTTPException(429, {
      res: Response.json(
        { detail: `Request was throttled. Expected available in ${retryAfter} seconds.`, error: { code: 'common.errThrottled' } },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      ),
    });
  }
}

/** Middleware form: `rateLimit('login', '5/min')`. */
export const rateLimit =
  (scope: string, rate: string, keyFn?: (c: Context<AppEnv>) => string | undefined): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    await checkRate(c, scope, rate, keyFn?.(c));
    await next();
  };
