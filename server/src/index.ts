import { Hono } from 'hono';
import * as Sentry from '@sentry/cloudflare';
import { sentryOptions } from './lib/sentry';
import type { AppEnv, Env } from './env';
import { rememberOrigin } from './lib/origin';
import { sameOriginGuard } from './lib/session';
import { errorHandler } from './middleware/error';
import { accountRoutes } from './routes/accounts';
import { coreRoutes } from './routes/core';
import { bookRoutes } from './routes/books';
import { listingRoutes } from './routes/listings';
import { searchRoutes } from './routes/search';
import { subscriptionRoutes } from './routes/subscriptions';
import { sitemapRoutes } from './routes/sitemap';
import { messagingRoutes } from './routes/messaging';
import { moderationRoutes } from './routes/moderation';
import { chatRoutes } from './routes/chat';
import { orderRoutes } from './routes/orders';
import { adminRoutes } from './routes/admin';
import { promotionRoutes } from './routes/promotions';
import { frontendRoutes } from './routes/frontend';
import { handleScheduled } from './jobs/index';
import { handleEmailQueue } from './queues/email';
import { handlePushQueue } from './queues/push';
import type { EmailMessage, PushMessage } from './queues/types';
import { EMAIL_QUEUE_NAME, PUSH_QUEUE_NAME } from './queues/names';

import { ChatRoom as ChatRoomDO } from './durable-objects/ChatRoom';
import { UserHub as UserHubDO } from './durable-objects/UserHub';
export { OrderLock } from './durable-objects/OrderLock';
export { RateLimiter } from './durable-objects/RateLimiter';

// The chat Durable Objects report errors to Sentry (when configured).
export const ChatRoom = Sentry.instrumentDurableObjectWithSentry(sentryOptions, ChatRoomDO);
export const UserHub = Sentry.instrumentDurableObjectWithSentry(sentryOptions, UserHubDO);

/**
 * The UniBooks Worker. Static assets (the Angular build) are served by the
 * platform before this runs; only the paths in wrangler.jsonc
 * `run_worker_first` reach it: /api/* and /<region>/book.
 *
 * REST resources live under /api/v1 with trailing-slash paths; chat under
 * /api/chat.
 *
 * Each module router is mounted with a trailing slash: Hono only matches a
 * sub-router's '/' route against the mount path exactly as written, and the
 * URLs the app calls end in '/' (e.g. GET /api/v1/listings/).
 */
export const app = new Hono<AppEnv>();

// One origin for app, API and chat: no CORS. Remember it for links in
// emails and pushes sent from queue consumers and cron jobs.
app.use('/api/*', rememberOrigin());
// Session cookies ride along automatically, so state changes must be same-origin.
app.use('/api/*', sameOriginGuard());
app.onError(errorHandler);

app.route('/api/v1/auth/', accountRoutes);
app.route('/api/v1/core/', coreRoutes);
app.route('/api/v1/books/', bookRoutes);
app.route('/api/v1/listings/', listingRoutes);
app.route('/api/v1/search/', searchRoutes);
app.route('/api/v1/subscriptions/', subscriptionRoutes);
app.route('/api/v1/messaging/', messagingRoutes);
app.route('/api/v1/moderation/', moderationRoutes);
app.route('/api/v1/orders/', orderRoutes);
app.route('/api/v1/admin/', adminRoutes);
app.route('/api/v1/promotions/', promotionRoutes);
app.route('/api/v1', sitemapRoutes); // /api/v1/sitemap.xml, /api/v1/sitemap/<kind>-<region>-<page>.xml

// Chat: hub + room WebSockets and room REST (see routes/chat.ts).
app.route('/api/chat', chatRoutes);

// /api/cover and /<region>/book (public pages and cover images).
app.route('/', frontendRoutes);

// Local development only: R2 objects under /api/media/<key> (production serves
// them from the R2 public domain, R2_PUBLIC_URL).
app.get('/api/media/*', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') return c.notFound();
  const key = decodeURIComponent(c.req.path.slice('/api/media/'.length));
  const obj = await c.env.R2.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  return new Response(obj.body, { headers });
});

app.notFound((c) => {
  const path = c.req.path;
  if (path.startsWith('/api/') || path === '/api') {
    return c.json({ detail: 'Not found.' }, 404);
  }
  // A run_worker_first path no route claimed (e.g. /tw/book without a match):
  // hand it back to the static app.
  return c.env.ASSETS.fetch(c.req.raw);
});

// Every named export of this module is treated as a Worker entrypoint by the
// runtime: export only handlers and Durable Object classes from here.
const worker = {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(controller, env));
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === EMAIL_QUEUE_NAME) {
      await handleEmailQueue(batch as MessageBatch<EmailMessage>, env);
    } else if (batch.queue === PUSH_QUEUE_NAME) {
      await handlePushQueue(batch as MessageBatch<PushMessage>, env);
    } else {
      console.warn(`[queue] unhandled queue ${batch.queue}`);
      batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(sentryOptions, worker);
