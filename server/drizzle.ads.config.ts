import { defineConfig } from 'drizzle-kit';

/** The ads database (D1 binding DB_ADS, "unibooks-ads-apac"). */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/ads-schema.ts',
  out: './src/db/ads-migrations',
});
