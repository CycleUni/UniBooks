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
          // Test-only secrets; production values come from `wrangler secret put`.
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_ADS_MIGRATIONS: adsMigrations,
            ENVIRONMENT: 'test',
            JWT_SIGNING_KEY: 'test-jwt-signing-key-not-for-production-0001',
            EDGE_CHAT_JWT_SECRET: 'test-edge-chat-secret-not-for-production-0002',
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
