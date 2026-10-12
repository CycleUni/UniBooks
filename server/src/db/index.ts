import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import * as adsSchema from './ads-schema';

/**
 * Creates a Drizzle ORM client instance backed by Cloudflare D1.
 *
 * @param d1 - The Cloudflare D1 database binding
 * @returns Type-safe Drizzle database instance configured with the schema
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof createDb>;

/** Drizzle client for the ads database (env.DB_ADS): advertisers and ads only. */
export function createAdsDb(d1: D1Database) {
  return drizzle(d1, { schema: adsSchema });
}

export type AdsDatabase = ReturnType<typeof createAdsDb>;

// Re-export all schema tables and inferred types
export * from './schema';
export * from './ads-schema';
export { schema, adsSchema };
