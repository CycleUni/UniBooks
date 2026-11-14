CREATE TABLE `conversation_listings` (
	`conversation_id` text NOT NULL,
	`listing_id` text,
	`listing_ref` text NOT NULL,
	`book_title` text DEFAULT '' NOT NULL,
	`book_isbn` text DEFAULT '' NOT NULL,
	`added_at` text NOT NULL,
	`added_by_id` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `listing_ref`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`added_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_listings_listing_id_idx` ON `conversation_listings` (`listing_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `conversation_listings` (`conversation_id`, `listing_id`, `listing_ref`, `book_title`, `book_isbn`, `added_at`, `added_by_id`)
SELECT `id`, `listing_id`, COALESCE(`listing_ref`, `listing_id`, `id`), `book_title`, `book_isbn`, `created_at`, `buyer_id`
FROM `conversations`
WHERE COALESCE(`listing_ref`, `listing_id`) IS NOT NULL;
