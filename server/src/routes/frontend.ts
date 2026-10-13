import { Hono, type Context } from 'hono';
import { checkRate } from '../middleware/rateLimit';
import type { AppEnv } from '../env';
import { activeRegions } from '../lib/region';
import { handleBookPage, injectBookMeta, regionFrom, REGION_SHELL, type SiteRegions } from '../services/frontend/bookMeta';
import { handleCover } from '../services/frontend/cover';

/**
 * The two routes the app needs a Worker for: /api/cover and /<region>/book.
 * Everything else the app needs is a static asset served by the platform
 * before the Worker runs; wrangler.jsonc `run_worker_first` sends /api/* and /*\/book here.
 */
export const frontendRoutes = new Hono<AppEnv>();

/** Upstream cover hosts get this long before the request counts as an upstream failure. */
const COVER_UPSTREAM_TIMEOUT_MS = 8000;

/**
 * /api/cover?src=<cover URL>: see services/frontend/cover.ts. Rate limited
 * only on an edge-cache miss: a page shows many covers, and a hit costs no
 * upstream fetch, so it should not cost a Durable Object call either.
 */
frontendRoutes.get('/api/cover', (c) =>
  handleCover(c.req.raw, {
    cache: caches.default,
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(COVER_UPSTREAM_TIMEOUT_MS) }),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    onMiss: () => checkRate(c, 'cover', '600/min'),
  }),
);

/** The static app's answer for this request, as if the Worker had not run. */
const fromAssets = (c: Context<AppEnv>) => c.env.ASSETS.fetch(c.req.raw);

async function siteRegions(env: AppEnv['Bindings']): Promise<SiteRegions> {
  const active = [...(await activeRegions(env)).values()].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.code.localeCompare(b.code),
  );
  const regions = active.map((r) => ({ code: r.code.toLowerCase(), lang: r.defaultLanguage }));
  const preferred = (env.DEFAULT_REGION || 'TW').toLowerCase();
  const defaultRegion = regions.some((r) => r.code === preferred) ? preferred : (regions[0]?.code ?? preferred);
  return { regions, defaultRegion };
}

/**
 * /<region>/book?isbn=… (or ?id=…): the region's app shell with og:,
 * twitter: and canonical tags a link preview can read. Only a lowercase
 * two-letter code naming an active region is handled; any other first
 * segment (/messages/book, /xx/book, /TW/book) is the static app's.
 */
frontendRoutes.get('/:region/book', async (c) => {
  const region = regionFrom(c.req.param('region'));
  if (!region) return fromAssets(c);

  let site: SiteRegions;
  try {
    site = await siteRegions(c.env);
  } catch {
    return fromAssets(c);
  }
  if (!site.regions.some((r) => r.code === region)) return fromAssets(c);

  const origin = new URL(c.req.url).origin;
  const clientIp = c.req.header('CF-Connecting-IP');
  try {
    return await handleBookPage(
      {
        request: c.req.raw,
        region,
        site,
        shell: () => c.env.ASSETS.fetch(new Request(`${origin}/${region}/${REGION_SHELL}`, { headers: { Accept: 'text/html' } })),
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      },
      {
        cache: caches.default,
        // In-process: the book API of this same Worker, never a network hop
        // to another deployment. No credentials are forwarded — the lookup
        // is the public one, and its answer is cached for everyone. The
        // client's IP goes along so the API's throttle sees the real caller.
        fetch: async (url, init) => {
          const { app } = await import('../index');
          const headers = new Headers(init.headers);
          if (clientIp) headers.set('CF-Connecting-IP', clientIp);
          return app.fetch(new Request(url, { ...init, headers }), c.env, c.executionCtx);
        },
        inject: injectBookMeta,
      },
    );
  } catch {
    return fromAssets(c);
  }
});
