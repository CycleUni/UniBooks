import { HTTPException } from 'hono/http-exception';
import * as Sentry from '@sentry/cloudflare';
import type { ErrorHandler } from 'hono';
import type { AppEnv } from '../env';

/**
 * An HTTPException raised through lib/http (apiError, fieldErrors, validate)
 * already carries its contract-shaped response; pass it through untouched.
 * Anything else is a bug: log it, and answer without internals — no message,
 * no stack — outside local development.
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.getResponse();
    return c.json({ error: { code: 'common.errRequest' } }, err.status);
  }
  console.error('[unhandled]', err);
  Sentry.captureException(err);
  const body: { error: { code: string; detail?: string } } = { error: { code: 'common.errServer' } };
  if (c.env.ENVIRONMENT === 'development') body.error.detail = String(err?.stack ?? err);
  return c.json(body, 500);
};
