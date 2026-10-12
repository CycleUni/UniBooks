import { describe, expect, it } from 'vitest';
import wranglerRaw from '../../wrangler.jsonc?raw';
import jobsSource from '../../src/jobs/index.ts?raw';
import { EMAIL_QUEUE_NAME, PUSH_QUEUE_NAME } from '../../src/queues/names';

// wrangler.jsonc is JSON with comments; strip whole-line comments to parse it.
const config = JSON.parse(wranglerRaw.replace(/^\s*\/\/.*$/gm, '')) as {
  queues: { consumers: { queue: string }[] };
  triggers: { crons: string[] };
};

describe('wrangler.jsonc matches the code', () => {
  it('every queue consumer is one the Worker dispatches', () => {
    expect(config.queues.consumers.map((c) => c.queue).sort()).toEqual([EMAIL_QUEUE_NAME, PUSH_QUEUE_NAME].sort());
  });

  it('every cron trigger has a job', () => {
    for (const cron of config.triggers.crons) expect(jobsSource).toContain(`'${cron}'`);
  });
});

describe('entry module exports', () => {
  it('exports only entrypoints (the runtime rejects anything else at startup)', async () => {
    const mod = (await import('../../src/index')) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      const ok = typeof value === 'function' || (typeof value === 'object' && value !== null && 'fetch' in value);
      expect(ok, `export ${name}`).toBe(true);
    }
  });
});
