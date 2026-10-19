import type { Env } from '../env';

/**
 * The site's public origin (e.g. https://unibooks.app), for links in emails,
 * push notifications and the sitemap.
 *
 * The app and the API share one origin, so a request already says where the
 * site lives. Work that runs without a request (queue consumers, cron jobs)
 * uses SITE_ORIGIN from wrangler.jsonc `vars` (.dev.vars overrides it locally).
 */
const DEFAULT_ORIGIN = 'https://unibooks.app';

/** The canonical site origin, without a trailing slash. */
export function siteOrigin(env: Env, requestUrl?: string): string {
  if (requestUrl) return new URL(requestUrl).origin;
  return (env.SITE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
}
