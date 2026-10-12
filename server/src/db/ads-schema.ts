import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

/**
 * Advertisers and ads, in their own D1 database (binding DB_ADS) so they can
 * move or scale apart from marketplace data.
 *
 * Nothing here references the main database: user_id, region_code and
 * school_id are plain columns that the admin routes validate against env.DB
 * on write. Impressions and clicks are not stored here at all — they go to
 * Workers Analytics Engine (binding AD_EVENTS) and are read back through the
 * SQL API (services/admin/adAnalytics.ts).
 */

// ============================================================================
// Advertisers
// ============================================================================
/** Advertisers (exposed to the admin UI as "sponsors"). */
export const advertisers = sqliteTable('advertisers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** users.id in the main DB; reserved for a future advertiser login. */
  userId: text('user_id').unique(),
  companyName: text('company_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  contactPhone: text('contact_phone').notNull().default(''),
  allRegions: integer('all_regions').notNull().default(0),
  allSchools: integer('all_schools').notNull().default(1),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type Advertiser = InferSelectModel<typeof advertisers>;
export type InsertAdvertiser = InferInsertModel<typeof advertisers>;
export type NewAdvertiser = InsertAdvertiser;

/** Advertiser.regions (M2M); region_code is regions.code in the main DB. */
export const advertiserRegions = sqliteTable(
  'advertiser_regions',
  {
    advertiserId: integer('advertiser_id')
      .notNull()
      .references(() => advertisers.id, { onDelete: 'cascade' }),
    regionCode: text('region_code').notNull(),
  },
  (table) => [
    unique('advertiser_regions_unique').on(table.advertiserId, table.regionCode),
    index('advertiser_regions_region_idx').on(table.regionCode),
  ],
);

/** Advertiser.schools (M2M); school_id is schools.id in the main DB. */
export const advertiserSchools = sqliteTable(
  'advertiser_schools',
  {
    advertiserId: integer('advertiser_id')
      .notNull()
      .references(() => advertisers.id, { onDelete: 'cascade' }),
    schoolId: integer('school_id').notNull(),
  },
  (table) => [
    unique('advertiser_schools_unique').on(table.advertiserId, table.schoolId),
    index('advertiser_schools_school_idx').on(table.schoolId),
  ],
);

// ============================================================================
// Ads
// ============================================================================
/** Ads (exposed as "promotions"). View/click counts live in Analytics Engine. */
export const ads = sqliteTable(
  'ads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    advertiserId: integer('advertiser_id')
      .notNull()
      .references(() => advertisers.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    imageUrl: text('image_url').notNull(),
    targetUrl: text('target_url').notNull(),
    position: text('position').notNull().default('home_banner'),
    headline: text('headline').notNull().default(''),
    subheadline: text('subheadline').notNull().default(''),
    slotIndex: integer('slot_index').notNull().default(1),
    /** JSON array of up to 3 strings, 15 chars each. */
    labels: text('labels').notNull().default('[]'),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    isActive: integer('is_active').notNull().default(1),
    showInHero: integer('show_in_hero').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('ad_active_pos_period_idx').on(table.isActive, table.position, table.startDate, table.endDate),
    index('ads_advertiser_id_idx').on(table.advertiserId),
  ],
);

export type Ad = InferSelectModel<typeof ads>;
export type InsertAd = InferInsertModel<typeof ads>;
export type NewAd = InsertAd;
