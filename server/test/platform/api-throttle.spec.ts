import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../src/env';
import { apiThrottle } from '../../src/middleware/rateLimit';
import { errorHandler } from '../../src/middleware/error';

/** A binding that lets `allowed` calls through, then refuses. */
const binding = (allowed: number) => {
  let calls = 0;
  return { limit: async () => ({ success: ++calls <= allowed }) } as unknown as RateLimit;
};

const appWith = () => {
  const app = new Hono<AppEnv>();
  app.use('/api/*', apiThrottle());
  app.onError(errorHandler);
  app.all('/api/x', (c) => c.json({ ok: true }));
  return app;
};

describe('apiThrottle', () => {
  it('lets requests through until the budget is spent, then answers 429 with Retry-After', async () => {
    const app = appWith();
    const env = { ENVIRONMENT: 'production', API_READ_LIMIT: binding(2) };
    expect((await app.request('/api/x', {}, env)).status).toBe(200);
    expect((await app.request('/api/x', {}, env)).status).toBe(200);
    const res = await app.request('/api/x', {}, env);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('10');
    expect(await res.json()).toEqual({ error: { code: 'common.errThrottled', wait: 10 } });
  });

  it('counts writes against their own budget', async () => {
    const app = appWith();
    const env = { ENVIRONMENT: 'production', API_READ_LIMIT: binding(100), API_WRITE_LIMIT: binding(1) };
    expect((await app.request('/api/x', { method: 'POST' }, env)).status).toBe(200);
    expect((await app.request('/api/x', { method: 'POST' }, env)).status).toBe(429);
    expect((await app.request('/api/x', {}, env)).status).toBe(200);
  });

  it('does nothing without a binding or under test', async () => {
    const app = appWith();
    expect((await app.request('/api/x', {}, { ENVIRONMENT: 'production' })).status).toBe(200);
    expect((await app.request('/api/x', {}, { ENVIRONMENT: 'test', API_READ_LIMIT: binding(0) })).status).toBe(200);
  });
});
