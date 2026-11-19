import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'src/db/migrations'));
      const adsMigrations = await readD1Migrations(path.join(import.meta.dirname, 'src/db/ads-migrations'));
      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // The ISBNnet resolver is a separate Worker, called over RPC; tests get a
          // stub that knows no ISBN.
          serviceBindings: { ISBNNET: 'isbnnet-resolver' },
          workers: [
            {
              name: 'isbnnet-resolver',
              modules: true,
              compatibilityDate: '2026-10-01',
              script: `import { WorkerEntrypoint } from 'cloudflare:workers';
                export default class extends WorkerEntrypoint {
                  async lookup() { return { status: 'not_found' }; }
                }`,
            },
          ],
          // A tiny stand-in for the Angular build, so the tests need no client build.
          assets: {
            directory: path.join(import.meta.dirname, 'test/fixtures/assets'),
            binding: 'ASSETS',
            assetConfig: { not_found_handling: 'single-page-application' },
          },
          // Production delivers mail at once (max_batch_timeout 0 in wrangler.jsonc).
          // Under Miniflare on Linux a zero batch timeout keeps the queue broker
          // busy after the last test, so the run never ends (CI sat until its
          // six-hour limit). Tests do not depend on the delay, so they take 1 s.
          queueConsumers: {
            'unibooks-email': { maxBatchSize: 10, maxBatchTimeout: 1, maxRetries: 5 },
            'unibooks-push': { maxBatchSize: 20, maxBatchTimeout: 10, maxRetries: 3 },
          },
          // Test-only secrets; production values come from `wrangler secret put`.
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_ADS_MIGRATIONS: adsMigrations,
            ENVIRONMENT: 'test',
            SECRET_KEY: 'test-secret-key-not-for-production-000000001',
            // Off in tests whatever .dev.vars holds; turnstile.spec turns it on explicitly.
            TURNSTILE_SECRET_KEY: '',
            TURNSTILE_SITE_KEY: '',
          },
        },
      };
    }),
  ],
  test: {
    include: ['test/**/*.spec.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
    // These are integration tests through Miniflare (D1, R2, queues, Durable
    // Objects), not unit tests. The first files run while the other workers
    // still compile and start Miniflare; on a busy CI runner that wave can
    // slow several-fold, and a test that takes ~350 ms there took 5-8 s and
    // failed the 5 s default. Locally they take tens of milliseconds, so a
    // real hang still fails, just later.
    testTimeout: 30_000,
  },
});
