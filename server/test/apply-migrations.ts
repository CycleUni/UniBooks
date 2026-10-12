import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Each test file gets isolated storage; bring both databases up to the current schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DB_ADS, env.TEST_ADS_MIGRATIONS);
