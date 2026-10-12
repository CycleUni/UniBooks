import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env';

/**
 * The site's public origin (e.g. https://unibooks.app), for links in emails,
 * push notifications and the sitemap.
 *
 * The app and the API share one origin, so a request already says where the
 * site lives. Work that runs without a request (queue consumers, cron jobs)
 * reads the origin the Worker recorded in KV. Only hostnames routed to this
 * Worker can reach it, so a client cannot point the value elsewhere.
 *
 * The first origin seen is kept; it is replaced only to upgrade from a
 * *.workers.dev fallback to a custom domain, so several routed hostnames
 * (apex, www, previews) never make it flip back and forth. This is
 * bookkeeping: a KV failure never fails the request.
 */
const KV_KEY = 'site:origin';
let known: string | null = null;

const isFallbackHost = (origin: string) => new URL(origin).hostname.endsWith('.workers.dev');

/** Records the request's origin when it should become the stored one (rare KV write). */
export const rememberOrigin = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const origin = new URL(c.req.url).origin;
  if (origin !== known) {
    try {
      const stored = known ?? (await c.env.KV.get(KV_KEY));
      if (!stored || (isFallbackHost(stored) && !isFallbackHost(origin))) {
        c.executionCtx.waitUntil(c.env.KV.put(KV_KEY, origin).catch(() => undefined));
        known = origin;
      } else {
        known = stored;
      }
    } catch (e) {
      console.warn('[origin] could not read the stored site origin', e);
    }
  }
  await next();
};

/** The canonical site origin, without a trailing slash. */
export async function siteOrigin(env: Env, requestUrl?: string): Promise<string> {
  if (requestUrl) return new URL(requestUrl).origin;
  if (known) return known;
  try {
    known = await env.KV.get(KV_KEY);
  } catch (e) {
    console.warn('[origin] could not read the stored site origin', e);
  }
  return known ?? 'https://unibooks.app';
}
