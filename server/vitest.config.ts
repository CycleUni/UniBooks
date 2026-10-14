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
          // The ISBNnet resolver is a separate Worker; tests get a stub that knows no ISBN.
          serviceBindings: { ISBNNET: () => new Response('not found', { status: 404 }) },
          // A tiny stand-in for the Angular build, so the tests need no client build.
          assets: {
            directory: path.join(import.meta.dirname, 'test/fixtures/assets'),
            binding: 'ASSETS',
            assetConfig: { not_found_handling: 'single-page-application' },
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
  },
});
