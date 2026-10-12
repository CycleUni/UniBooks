CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`details` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_events_actor_id_idx` ON `audit_events` (`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_events_target_idx` ON `audit_events` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`isbn13` text,
	`title` text NOT NULL,
	`authors` text DEFAULT '' NOT NULL,
	`publisher` text DEFAULT '' NOT NULL,
	`published_date` text DEFAULT '' NOT NULL,
	`cover_url` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	`reviewed_by_id` text,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `books_region_created_idx` ON `books` (`region_code`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `books_region_code_isbn13_unique` ON `books` (`region_code`,`isbn13`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`region_code` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_region_unique` ON `categories` (`slug`,`region_code`);--> statement-breakpoint
CREATE TABLE `chat_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`region_code` text NOT NULL,
	`reported_party_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`flagged_message_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reported_party_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_reports_reporter_id_idx` ON `chat_reports` (`reporter_id`);--> statement-breakpoint
CREATE INDEX `chat_reports_conversation_id_idx` ON `chat_reports` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `chat_reports_region_status_idx` ON `chat_reports` (`region_code`,`status`);--> statement-breakpoint
CREATE TABLE `cities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`region_code` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cities_region_code_code_unique` ON `cities` (`region_code`,`code`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`region_code` text NOT NULL,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`listing_id` text,
	`listing_ref` text,
	`book_title` text DEFAULT '' NOT NULL,
	`book_isbn` text DEFAULT '' NOT NULL,
	`latest_message_body` text,
	`last_message_at` text,
	`updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`buyer_deleted_at` text,
	`seller_deleted_at` text,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_room_id_unique` ON `conversations` (`room_id`);--> statement-breakpoint
CREATE INDEX `conversations_buyer_id_idx` ON `conversations` (`buyer_id`);--> statement-breakpoint
CREATE INDEX `conversations_seller_id_idx` ON `conversations` (`seller_id`);--> statement-breakpoint
CREATE INDEX `conversations_listing_ref_buyer_idx` ON `conversations` (`listing_ref`,`buyer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_listing_buyer_unique` ON `conversations` (`listing_id`,`buyer_id`);--> statement-breakpoint
CREATE TABLE `currencies` (
	`code` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`decimal_places` integer DEFAULT 2 NOT NULL,
	`symbol_position` text DEFAULT 'prefix' NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `languages` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`native_name` text DEFAULT '' NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`currency_code` text NOT NULL,
	`book_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`school_id` integer,
	`price` integer NOT NULL,
	`condition` text NOT NULL,
	`private_note` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`photos` text DEFAULT '[]' NOT NULL,
	`category_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`admin_locked` integer DEFAULT 0 NOT NULL,
	`admin_lock_reason` text DEFAULT '' NOT NULL,
	`locked_by_id` text,
	`locked_at` text,
	`course_name` text DEFAULT '' NOT NULL,
	`professor_name` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`locked_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `listings_region_status_created_idx` ON `listings` (`region_code`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `listings_region_status_category_idx` ON `listings` (`region_code`,`status`,`category_id`);--> statement-breakpoint
CREATE INDEX `listings_region_status_course_idx` ON `listings` (`region_code`,`status`,`course_name`);--> statement-breakpoint
CREATE INDEX `listings_region_status_id_idx` ON `listings` (`region_code`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `listings_seller_id_idx` ON `listings` (`seller_id`);--> statement-breakpoint
CREATE INDEX `listings_book_id_idx` ON `listings` (`book_id`);--> statement-breakpoint
CREATE TABLE `one_time_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`payload` text,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_time_tokens_token_hash_unique` ON `one_time_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `one_time_tokens_user_purpose_idx` ON `one_time_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`currency_code` text NOT NULL,
	`listing_id` text,
	`listing_ref` text,
	`book_title` text DEFAULT '' NOT NULL,
	`book_isbn` text DEFAULT '' NOT NULL,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cancel_reason` text,
	`total_amount` integer NOT NULL,
	`meetup_time` text,
	`meetup_location` text DEFAULT '' NOT NULL,
	`meetup_reminder_sent_at` text,
	`buyer_reminder_sent_at` text,
	`seller_reminder_sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`no_show_reportable` integer DEFAULT 0 NOT NULL,
	`meetup_set_at` text,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orders_buyer_id_idx` ON `orders` (`buyer_id`);--> statement-breakpoint
CREATE INDEX `orders_seller_id_idx` ON `orders` (`seller_id`);--> statement-breakpoint
CREATE INDEX `orders_listing_id_idx` ON `orders` (`listing_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_open_buyer_listing_uniq` ON `orders` (`listing_id`,`buyer_id`) WHERE status IN ('pending', 'accepted', 'handed_over');--> statement-breakpoint
CREATE INDEX `orders_listing_ref_idx` ON `orders` (`listing_ref`);--> statement-breakpoint
CREATE INDEX `order_region_created_idx` ON `orders` (`region_code`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_status_meetup_time_idx` ON `orders` (`status`,`meetup_time`);--> statement-breakpoint
CREATE TABLE `push_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`platform` text DEFAULT 'web' NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_token_unique` ON `push_devices` (`token`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`jti` text NOT NULL,
	`user_id` text NOT NULL,
	`family_id` text NOT NULL,
	`is_revoked` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`replaced_by_id` text,
	`rotated_at` text,
	`rotated_tokens` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaced_by_id`) REFERENCES `refresh_tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_jti_unique` ON `refresh_tokens` (`jti`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_family_id_idx` ON `refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_user_id_idx` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `region_verifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`region_code` text NOT NULL,
	`school_id` integer,
	`edu_email` text,
	`is_manual_verification` integer DEFAULT 0 NOT NULL,
	`verified_at` text NOT NULL,
	`last_reverified_at` text,
	`expires_at` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `region_verifications_edu_email_unique` ON `region_verifications` (`edu_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `region_verifications_user_region_unique` ON `region_verifications` (`user_id`,`region_code`);--> statement-breakpoint
CREATE TABLE `regions` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`default_currency` text NOT NULL,
	`default_language` text NOT NULL,
	`timezone` text NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`languages` text DEFAULT '[]' NOT NULL,
	`search_engines` text DEFAULT '[]' NOT NULL,
	`edu_email_suffix` text DEFAULT '[]' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`default_currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_language`) REFERENCES `languages`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`listing_id` text,
	`seller_id` text,
	`region_code` text,
	`listing_ref` text,
	`book_title` text DEFAULT '' NOT NULL,
	`reason` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reports_reporter_id_idx` ON `reports` (`reporter_id`);--> statement-breakpoint
CREATE INDEX `reports_listing_ref_idx` ON `reports` (`listing_ref`);--> statement-breakpoint
CREATE INDEX `reports_region_status_idx` ON `reports` (`region_code`,`status`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`reviewee_id` text NOT NULL,
	`rating` integer,
	`comment` text DEFAULT '' NOT NULL,
	`is_no_show` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reviews_reviewee_id_idx` ON `reviews` (`reviewee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_order_reviewer_unique` ON `reviews` (`order_id`,`reviewer_id`);--> statement-breakpoint
CREATE TABLE `school_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`region_code` text NOT NULL,
	`user_id` text NOT NULL,
	`school_name` text NOT NULL,
	`school_website` text NOT NULL,
	`edu_email` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`admin_note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `school_requests_region_status_created_idx` ON `school_requests` (`region_code`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `school_requests_one_pending_per_user_region_name` ON `school_requests` (`user_id`,`region_code`,lower("school_name")) WHERE "school_requests"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `schools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`region_code` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`email_domain` text NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`city_id` integer,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`city_id`) REFERENCES `cities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schools_email_domain_unique` ON `schools` (`email_domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `schools_region_code_code_unique` ON `schools` (`region_code`,`code`);--> statement-breakpoint
CREATE TABLE `staff_managed_regions` (
	`user_id` text NOT NULL,
	`region_code` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_managed_regions_unique` ON `staff_managed_regions` (`user_id`,`region_code`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`school_id` integer,
	`notified_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `subscriptions_user_region_idx` ON `subscriptions` (`user_id`,`region_code`);--> statement-breakpoint
CREATE INDEX `subscriptions_book_id_idx` ON `subscriptions` (`book_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_book_unique` ON `subscriptions` (`user_id`,`book_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`password_hash` text,
	`avatar_url` text,
	`show_avatar` integer DEFAULT 1 NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`google_id` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`is_banned` integer DEFAULT 0 NOT NULL,
	`ban_reason` text,
	`last_login_at` text,
	`last_seen_bought_orders_at` text,
	`last_seen_sold_orders_at` text,
	`notify_new_message_email` integer DEFAULT 1 NOT NULL,
	`notify_push` integer DEFAULT 1 NOT NULL,
	`email_language` text DEFAULT 'auto' NOT NULL,
	`site_language` text DEFAULT '' NOT NULL,
	`site_region` text DEFAULT '' NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_id_unique` ON `users` (`google_id`);