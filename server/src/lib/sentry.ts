import type { Env } from '../env';

/**
 * Sentry for the Worker and its Durable Objects. Off unless SENTRY_DSN is set;
 * the SDK sends no request bodies, cookies or IPs by default.
 */
export const sentryOptions = (env: Env) => ({
  dsn: env.SENTRY_DSN,
  enabled: !!env.SENTRY_DSN,
  environment: env.ENVIRONMENT,
  tracesSampleRate: 0.05,
});
