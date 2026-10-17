import { sqliteTable, text, integer, index, uniqueIndex, unique } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

// ============================================================================
// 1. Currencies
// ============================================================================
export const currencies = sqliteTable('currencies', {
  code: text('code').primaryKey(),
  symbol: text('symbol').notNull(),
  decimalPlaces: integer('decimal_places').notNull().default(2),
  symbolPosition: text('symbol_position', { enum: ['prefix', 'suffix'] })
    .notNull()
    .default('prefix'),
  isActive: integer('is_active').notNull().default(1),
});

export type Currency = InferSelectModel<typeof currencies>;
export type InsertCurrency = InferInsertModel<typeof currencies>;
export type NewCurrency = InsertCurrency;

// ============================================================================
// 2. Languages
// ============================================================================
export const languages = sqliteTable('languages', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  nativeName: text('native_name').notNull().default(''),
  isActive: integer('is_active').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
});

export type Language = InferSelectModel<typeof languages>;
export type InsertLanguage = InferInsertModel<typeof languages>;
export type NewLanguage = InsertLanguage;

// ============================================================================
// 3. Regions
// ============================================================================
export const regions = sqliteTable('regions', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  defaultCurrency: text('default_currency')
    .notNull()
    .references(() => currencies.code),
  defaultLanguage: text('default_language')
    .notNull()
    .references(() => languages.code),
  timezone: text('timezone').notNull(),
  /** JSON {"zh-TW": {"name": "台灣"}, ...}. */
  translations: text('translations').notNull().default('{}'),
  /** JSON array of language codes the region supports. */
  languages: text('languages').notNull().default('[]'),
  /** JSON array, e.g. ["googlebooks","openlibrary","isbnnet"]. */
  searchEngines: text('search_engines').notNull().default('[]'),
  /** JSON array, e.g. [".edu.tw"]. */
  eduEmailSuffix: text('edu_email_suffix').notNull().default('[]'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull(),
});

export type Region = InferSelectModel<typeof regions>;
export type InsertRegion = InferInsertModel<typeof regions>;
export type NewRegion = InsertRegion;

// ============================================================================
// 4. Cities
// ============================================================================
export const cities = sqliteTable(
  'cities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code, { onDelete: 'cascade' }),
    /** Unique within the region (ISO 3166-2:TW for Taiwan: "TPE"). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    translations: text('translations').notNull().default('{}'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [unique('cities_region_code_code_unique').on(table.regionCode, table.code)],
);

export type City = InferSelectModel<typeof cities>;
export type InsertCity = InferInsertModel<typeof cities>;
export type NewCity = InsertCity;

// ============================================================================
// 5. Categories
// ============================================================================
/**
 * Homepage college category, one row per region.
 * `title`/`description` are canonical English; localized values live in
 * `translations` JSON: {"zh-TW": {"title": "商管學院", "description": "..."}}.
 */
export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    translations: text('translations').notNull().default('{}'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
  },
  (table) => [unique('categories_slug_region_unique').on(table.slug, table.regionCode)],
);

export type Category = InferSelectModel<typeof categories>;
export type InsertCategory = InferInsertModel<typeof categories>;
export type NewCategory = InsertCategory;

// ============================================================================
// 6. Users
// ============================================================================
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  // Stored fully lower-cased (registration, Google sign-in, email change).
  email: text('email').notNull().unique(),
  // Derived display name, kept in step with
  // first_name/last_name by services/accounts/users.ts for readers that only
  // want a label (push, chat).
  name: text('name').notNull().default(''),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  // NULL = unusable password (Google-only account, or a deleted one).
  passwordHash: text('password_hash'),
  avatarUrl: text('avatar_url'),
  // Whether other users see avatar_url; the owner always does.
  showAvatar: integer('show_avatar').notNull().default(1),
  // staff = 'staff' | 'admin', admin = 'admin'.
  role: text('role', { enum: ['user', 'staff', 'admin'] })
    .notNull()
    .default('user'),
  // The linked Google account's `sub`.
  googleId: text('google_id').unique(),
  isActive: integer('is_active').notNull().default(1),
  isBanned: integer('is_banned').notNull().default(0),
  banReason: text('ban_reason'),
  lastLoginAt: text('last_login_at'),
  lastSeenBoughtOrdersAt: text('last_seen_bought_orders_at'),
  lastSeenSoldOrdersAt: text('last_seen_sold_orders_at'),
  // Notification preferences.
  notifyNewMessageEmail: integer('notify_new_message_email').notNull().default(1),
  notifyPush: integer('notify_push').notNull().default(1),
  emailLanguage: text('email_language').notNull().default('auto'),
  siteLanguage: text('site_language').notNull().default(''),
  siteRegion: text('site_region').notNull().default(''),
  // Set when the owner deletes the account; the row stays, anonymized.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type User = InferSelectModel<typeof users>;
export type InsertUser = InferInsertModel<typeof users>;
export type NewUser = InsertUser;

// ============================================================================
// 7. Schools
// ============================================================================
export const schools = sqliteTable(
  'schools',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    /** Short code ("NTU"), unique within the region only. */
    code: text('code').notNull(),
    /** Canonical English name; localized names in `translations` {"zh-TW": {"name": ...}}. */
    name: text('name').notNull(),
    /** e.g. ntu.edu.tw — globally unique. */
    emailDomain: text('email_domain').notNull().unique(),
    translations: text('translations').notNull().default('{}'),
    cityId: integer('city_id').references(() => cities.id, { onDelete: 'set null' }),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at').notNull(),
  },
  (table) => [unique('schools_region_code_code_unique').on(table.regionCode, table.code)],
);

export type School = InferSelectModel<typeof schools>;
export type InsertSchool = InferInsertModel<typeof schools>;
export type NewSchool = InsertSchool;

// ============================================================================
// 8. Region Verifications
// ============================================================================
export const regionVerifications = sqliteTable(
  'region_verifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    // A verification outlives its school row.
    schoolId: integer('school_id').references(() => schools.id),
    // Lower-cased; unique across ALL rows, active or not.
    // NULL only for a manual (staff) verification.
    eduEmail: text('edu_email').unique(),
    isManualVerification: integer('is_manual_verification').notNull().default(0),
    verifiedAt: text('verified_at').notNull(),
    lastReverifiedAt: text('last_reverified_at'),
    expiresAt: text('expires_at'),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at'),
  },
  (table) => [unique('region_verifications_user_region_unique').on(table.userId, table.regionCode)],
);

export type RegionVerification = InferSelectModel<typeof regionVerifications>;
export type InsertRegionVerification = InferInsertModel<typeof regionVerifications>;
export type NewRegionVerification = InsertRegionVerification;

// ============================================================================
// 9. Refresh Tokens
// ============================================================================
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    jti: text('jti').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // The jti of the chain's first token (one sign-in = one family).
    familyId: text('family_id').notNull(),
    // Unused by the rotation logic (a revoked live token is deleted);
    // kept for the cleanup cron.
    isRevoked: integer('is_revoked').notNull().default(0),
    expiresAt: text('expires_at').notNull(),
    replacedById: text('replaced_by_id').references((): any => refreshTokens.id),
    // Set when this token was exchanged; NULL = live token.
    rotatedAt: text('rotated_at'),
    // JSON {"access","refresh"} the token was rotated into, handed back to a
    // concurrent replay within the grace window; blanked by the cleanup cron.
    rotatedTokens: text('rotated_tokens'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('refresh_tokens_family_id_idx').on(table.familyId), index('refresh_tokens_user_id_idx').on(table.userId)],
);

export type RefreshToken = InferSelectModel<typeof refreshTokens>;
export type InsertRefreshToken = InferInsertModel<typeof refreshTokens>;
export type NewRefreshToken = InsertRefreshToken;

// ============================================================================
// 10. One-Time Tokens
// ============================================================================
export const oneTimeTokens = sqliteTable(
  'one_time_tokens',
  {
    id: text('id').primaryKey(),
    // SHA-256 of the mailed token; the token itself is never stored.
    tokenHash: text('token_hash').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // 'register' | 'edu_verify' | 'password_reset' | 'email_change'
    purpose: text('purpose').notNull(),
    payload: text('payload'),
    expiresAt: text('expires_at').notNull(),
    // Single use: consumed by a conditional UPDATE ... WHERE used_at IS NULL.
    usedAt: text('used_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('one_time_tokens_user_purpose_idx').on(table.userId, table.purpose)],
);

export type OneTimeToken = InferSelectModel<typeof oneTimeTokens>;
export type InsertOneTimeToken = InferInsertModel<typeof oneTimeTokens>;
export type NewOneTimeToken = InsertOneTimeToken;

// ============================================================================
// 11. Push Devices
// ============================================================================
export const pushDevices = sqliteTable('push_devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  // FCM registration token (max 512 chars); unique, so registering it moves
  // it to the signed-in account.
  token: text('token').notNull().unique(),
  platform: text('platform').notNull().default('web'),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type PushDevice = InferSelectModel<typeof pushDevices>;
export type InsertPushDevice = InferInsertModel<typeof pushDevices>;
export type NewPushDevice = InsertPushDevice;

// ============================================================================
// 12. School Requests
// ============================================================================
export const schoolRequests = sqliteTable(
  'school_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    schoolName: text('school_name').notNull(),
    schoolWebsite: text('school_website').notNull(),
    // What the user typed (lower-cased), '' if nothing; never verified.
    eduEmail: text('edu_email').notNull().default(''),
    // 'pending' | 'added' | 'rejected'
    status: text('status').notNull().default('pending'),
    adminNote: text('admin_note').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('school_requests_region_status_created_idx').on(table.regionCode, table.status, table.createdAt),
    // One open request per user, region and (case-folded) school name.
    uniqueIndex('school_requests_one_pending_per_user_region_name')
      .on(table.userId, table.regionCode, sql`lower(${table.schoolName})`)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type SchoolRequest = InferSelectModel<typeof schoolRequests>;
export type InsertSchoolRequest = InferInsertModel<typeof schoolRequests>;
export type NewSchoolRequest = InsertSchoolRequest;

// ============================================================================
// 13. Books
// ============================================================================
export const books = sqliteTable(
  'books',
  {
    // Ids are opaque UUID text.
    id: text('id').primaryKey(),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    // Unique per region (NULLs are distinct in SQLite, so ISBN-less books coexist).
    isbn13: text('isbn13'),
    title: text('title').notNull(),
    authors: text('authors').notNull().default(''),
    publisher: text('publisher').notNull().default(''),
    publishedDate: text('published_date').notNull().default(''),
    coverUrl: text('cover_url').notNull().default(''),
    source: text('source', {
      enum: ['listed', 'preseed', 'manual', 'google_api', 'openlibrary_api', 'isbnnet_api'],
    }).notNull(),
    createdAt: text('created_at').notNull(),
    // Admin review of a 'manual' book (null = waiting in the review queue).
    reviewedAt: text('reviewed_at'),
    reviewedById: text('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    unique('books_region_code_isbn13_unique').on(table.regionCode, table.isbn13),
    index('books_region_created_idx').on(table.regionCode, table.createdAt),
  ],
);

export type Book = InferSelectModel<typeof books>;
export type InsertBook = InferInsertModel<typeof books>;
export type NewBook = InsertBook;

// ============================================================================
// 14. Listings
// ============================================================================
export const listings = sqliteTable(
  'listings',
  {
    id: text('id').primaryKey(),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    currencyCode: text('currency_code')
      .notNull()
      .references(() => currencies.code),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id),
    schoolId: integer('school_id').references(() => schools.id, { onDelete: 'set null' }),
    price: integer('price').notNull(),
    condition: text('condition', { enum: ['new', 'like_new', 'noted', 'damaged'] }).notNull(),
    privateNote: text('private_note').notNull().default(''),
    description: text('description').notNull().default(''),
    // JSON array of public photo URLs (R2_PUBLIC_URL/listings/<userId>/<uuid>.<ext>).
    photos: text('photos').notNull().default('[]'),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['active', 'reserved', 'sold', 'removed'] })
      .notNull()
      .default('active'),
    adminLocked: integer('admin_locked').notNull().default(0),
    adminLockReason: text('admin_lock_reason').notNull().default(''),
    lockedById: text('locked_by_id').references(() => users.id, { onDelete: 'set null' }),
    lockedAt: text('locked_at'),
    courseName: text('course_name').notNull().default(''),
    professorName: text('professor_name').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('listings_region_status_created_idx').on(table.regionCode, table.status, table.createdAt),
    index('listings_region_status_category_idx').on(table.regionCode, table.status, table.categoryId),
    index('listings_region_status_course_idx').on(table.regionCode, table.status, table.courseName),
    index('listings_region_status_id_idx').on(table.regionCode, table.status, table.id),
    index('listings_seller_id_idx').on(table.sellerId),
    // Book pages and the waitlist job: a book's listings by status and age.
    index('listings_book_status_created_idx').on(table.bookId, table.status, table.createdAt),
  ],
);

export type Listing = InferSelectModel<typeof listings>;
export type InsertListing = InferInsertModel<typeof listings>;
export type NewListing = InsertListing;

// ============================================================================
// 15. Orders
// ============================================================================
export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    // Copied from the listing at creation: total_amount is in this currency.
    currencyCode: text('currency_code')
      .notNull()
      .references(() => currencies.code),
    // SET NULL: the order (and its reviews) outlives a deleted listing and is
    // shown from the snapshot (listing_ref, book_title, book_isbn).
    listingId: text('listing_id').references(() => listings.id, { onDelete: 'set null' }),
    listingRef: text('listing_ref'),
    bookTitle: text('book_title').notNull().default(''),
    bookIsbn: text('book_isbn').notNull().default(''),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => users.id),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id),
    // pending | accepted | handed_over | completed | cancelled
    status: text('status', { enum: ['pending', 'accepted', 'handed_over', 'completed', 'cancelled'] })
      .notNull()
      .default('pending'),
    cancelReason: text('cancel_reason'),
    totalAmount: integer('total_amount').notNull(),
    meetupTime: text('meetup_time'),
    meetupLocation: text('meetup_location').notNull().default(''),
    meetupReminderSentAt: text('meetup_reminder_sent_at'),
    buyerReminderSentAt: text('buyer_reminder_sent_at'),
    sellerReminderSentAt: text('seller_reminder_sent_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // Set once, when the buyer confirms receipt.
    completedAt: text('completed_at'),
    // Set (1) when a party cancels an accepted order once its agreed meetup
    // time has passed: the only cancellation a no-show report may follow.
    // Decided under the order lock from the pre-cancel row, so a party
    // cannot cancel early (or rewrite the time in the cancel) and then
    // file a no-show against the other.
    noShowReportable: integer('no_show_reportable').notNull().default(0),
    // When meetup_time was last set (accept or seller edit). A no-show may
    // only be reported for a meetup arranged at least an hour in advance.
    meetupSetAt: text('meetup_set_at'),
  },
  (table) => [
    index('orders_buyer_id_idx').on(table.buyerId),
    index('orders_seller_id_idx').on(table.sellerId),
    index('orders_listing_id_idx').on(table.listingId),
    // One open order per buyer per listing (order spam / notification flood guard).
    uniqueIndex('orders_open_buyer_listing_uniq')
      .on(table.listingId, table.buyerId)
      .where(sql`status IN ('pending', 'accepted', 'handed_over')`),
    index('orders_listing_ref_idx').on(table.listingRef),
    index('order_region_created_idx').on(table.regionCode, table.createdAt),
    index('order_status_meetup_time_idx').on(table.status, table.meetupTime),
  ],
);

export type Order = InferSelectModel<typeof orders>;
export type InsertOrder = InferInsertModel<typeof orders>;
export type NewOrder = InsertOrder;

// ============================================================================
// 16. Reviews
// ============================================================================
export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    reviewerId: text('reviewer_id')
      .notNull()
      .references(() => users.id),
    revieweeId: text('reviewee_id')
      .notNull()
      .references(() => users.id),
    // 1..5; null for a no-show report.
    rating: integer('rating'),
    comment: text('comment').notNull().default(''),
    isNoShow: integer('is_no_show').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // One review per party per order (the reviewee follows from the reviewer).
    unique('reviews_order_reviewer_unique').on(table.orderId, table.reviewerId),
    index('reviews_reviewee_id_idx').on(table.revieweeId),
  ],
);

export type Review = InferSelectModel<typeof reviews>;
export type InsertReview = InferInsertModel<typeof reviews>;
export type NewReview = InsertReview;

// ============================================================================
// 17. Conversations
// ============================================================================
// Conversations. The chat room id IS the conversation id
// (`room_id` is kept equal to `id`). Listing details are snapshotted at
// creation so the chat survives the listing: when a
// listing is deleted its conversations get listing_id = NULL and keep
// listing_ref / book_title / book_isbn.
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull().unique(),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => users.id),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id),
    listingId: text('listing_id').references(() => listings.id),
    listingRef: text('listing_ref'),
    bookTitle: text('book_title').notNull().default(''),
    bookIsbn: text('book_isbn').notNull().default(''),
    /** Inbox preview, written by the ChatRoom DO on every message. */
    latestMessageBody: text('latest_message_body'),
    lastMessageAt: text('last_message_at'),
    /** Inbox sort key and the `updated_at` the app shows. */
    updatedAt: text('updated_at').notNull(),
    createdAt: text('created_at').notNull(),
    /** Per-participant soft delete; the row goes when both are set. */
    buyerDeletedAt: text('buyer_deleted_at'),
    sellerDeletedAt: text('seller_deleted_at'),
  },
  (table) => [
    unique('conversations_listing_buyer_unique').on(table.listingId, table.buyerId),
    index('conversations_buyer_id_idx').on(table.buyerId),
    index('conversations_seller_id_idx').on(table.sellerId),
    index('conversations_listing_ref_buyer_idx').on(table.listingRef, table.buyerId),
  ],
);

export type Conversation = InferSelectModel<typeof conversations>;
export type InsertConversation = InferInsertModel<typeof conversations>;
export type NewConversation = InsertConversation;

// ============================================================================
// 18. Reports (listing reports)
// ============================================================================
export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    reporterId: text('reporter_id')
      .notNull()
      .references(() => users.id),
    /** NULL once the listing is deleted; listing_ref / book_title remain. */
    listingId: text('listing_id').references(() => listings.id),
    sellerId: text('seller_id').references(() => users.id),
    regionCode: text('region_code').references(() => regions.code),
    listingRef: text('listing_ref'),
    bookTitle: text('book_title').notNull().default(''),
    reason: text('reason', { enum: ['fake', 'scam', 'other'] }).notNull(),
    detail: text('detail').notNull().default(''),
    status: text('status', { enum: ['open', 'actioned', 'dismissed'] })
      .notNull()
      .default('open'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('reports_reporter_id_idx').on(table.reporterId),
    index('reports_listing_ref_idx').on(table.listingRef),
    index('reports_region_status_idx').on(table.regionCode, table.status),
  ],
);

export type Report = InferSelectModel<typeof reports>;
export type InsertReport = InferInsertModel<typeof reports>;
export type NewReport = InsertReport;

// ============================================================================
// 19. Chat Reports
// ============================================================================
// Deleted with its conversation.
export const chatReports = sqliteTable(
  'chat_reports',
  {
    id: text('id').primaryKey(),
    reporterId: text('reporter_id')
      .notNull()
      .references(() => users.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    /** Copied from the conversation: staff scoping and the region filters. */
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    reportedPartyId: text('reported_party_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason', { enum: ['harassment', 'scam', 'spam', 'other'] }).notNull(),
    detail: text('detail').notNull().default(''),
    status: text('status', { enum: ['open', 'actioned', 'dismissed'] })
      .notNull()
      .default('open'),
    /** JSON array of chat message ids. */
    flaggedMessageIds: text('flagged_message_ids').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('chat_reports_reporter_id_idx').on(table.reporterId),
    index('chat_reports_conversation_id_idx').on(table.conversationId),
    index('chat_reports_region_status_idx').on(table.regionCode, table.status),
  ],
);

export type ChatReport = InferSelectModel<typeof chatReports>;
export type InsertChatReport = InferInsertModel<typeof chatReports>;
export type NewChatReport = InsertChatReport;

// ============================================================================
// 20. Subscriptions
// ============================================================================
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    schoolId: integer('school_id').references(() => schools.id, { onDelete: 'set null' }),
    notifiedAt: text('notified_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // A book row is region-scoped already.
    unique('subscriptions_user_book_unique').on(table.userId, table.bookId),
    index('subscriptions_user_region_idx').on(table.userId, table.regionCode),
    index('subscriptions_book_id_idx').on(table.bookId),
  ],
);

export type Subscription = InferSelectModel<typeof subscriptions>;
export type InsertSubscription = InferInsertModel<typeof subscriptions>;
export type NewSubscription = InsertSubscription;

// ============================================================================
// 21. Audit Events (advertisers and ads live in ads-schema.ts, D1 DB_ADS)
// ============================================================================
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The acting user; kept as NULL if that user is deleted. */
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** The event kind, e.g. 'admin.user_updated'. */
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    details: text('details'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('audit_events_actor_id_idx').on(table.actorId), index('audit_events_target_idx').on(table.targetType, table.targetId)],
);

export type AuditEvent = InferSelectModel<typeof auditEvents>;
export type InsertAuditEvent = InferInsertModel<typeof auditEvents>;
export type NewAuditEvent = InsertAuditEvent;

// ============================================================================
// 22. Staff managed regions
// ============================================================================
/**
 * The regions a non-admin staff account may administer.
 * Admins (role 'admin') see every region regardless of rows here.
 */
export const staffManagedRegions = sqliteTable(
  'staff_managed_regions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code, { onDelete: 'cascade' }),
  },
  (table) => [unique('staff_managed_regions_unique').on(table.userId, table.regionCode)],
);

export type StaffManagedRegion = InferSelectModel<typeof staffManagedRegions>;

// ============================================================================
// 23. Passkeys (WebAuthn credentials)
// ============================================================================
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports'),
    deviceType: text('device_type').notNull(),
    backedUp: integer('backed_up').notNull().default(0),
    name: text('name').notNull(),
    aaguid: text('aaguid'),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (table) => [index('passkeys_user_idx').on(table.userId)],
);

export type Passkey = InferSelectModel<typeof passkeys>;
export type InsertPasskey = InferInsertModel<typeof passkeys>;
export type NewPasskey = InsertPasskey;
