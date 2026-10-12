CREATE TABLE `ads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`advertiser_id` integer NOT NULL,
	`title` text NOT NULL,
	`image_url` text NOT NULL,
	`target_url` text NOT NULL,
	`position` text DEFAULT 'home_banner' NOT NULL,
	`headline` text DEFAULT '' NOT NULL,
	`subheadline` text DEFAULT '' NOT NULL,
	`slot_index` integer DEFAULT 1 NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`show_in_hero` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`advertiser_id`) REFERENCES `advertisers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ad_active_pos_period_idx` ON `ads` (`is_active`,`position`,`start_date`,`end_date`);--> statement-breakpoint
CREATE INDEX `ads_advertiser_id_idx` ON `ads` (`advertiser_id`);--> statement-breakpoint
CREATE TABLE `advertiser_regions` (
	`advertiser_id` integer NOT NULL,
	`region_code` text NOT NULL,
	FOREIGN KEY (`advertiser_id`) REFERENCES `advertisers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `advertiser_regions_region_idx` ON `advertiser_regions` (`region_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `advertiser_regions_unique` ON `advertiser_regions` (`advertiser_id`,`region_code`);--> statement-breakpoint
CREATE TABLE `advertiser_schools` (
	`advertiser_id` integer NOT NULL,
	`school_id` integer NOT NULL,
	FOREIGN KEY (`advertiser_id`) REFERENCES `advertisers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `advertiser_schools_school_idx` ON `advertiser_schools` (`school_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `advertiser_schools_unique` ON `advertiser_schools` (`advertiser_id`,`school_id`);--> statement-breakpoint
CREATE TABLE `advertisers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`company_name` text NOT NULL,
	`contact_email` text NOT NULL,
	`contact_phone` text DEFAULT '' NOT NULL,
	`all_regions` integer DEFAULT 0 NOT NULL,
	`all_schools` integer DEFAULT 1 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertisers_user_id_unique` ON `advertisers` (`user_id`);