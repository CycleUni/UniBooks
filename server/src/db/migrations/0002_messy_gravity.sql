CREATE TABLE `book_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`region_code` text NOT NULL,
	`reporter_id` text NOT NULL,
	`fields` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`suggested` text,
	`status` text DEFAULT 'open' NOT NULL,
	`admin_note` text DEFAULT '' NOT NULL,
	`resolved_by_id` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `book_reports_region_status_created_idx` ON `book_reports` (`region_code`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `book_reports_book_id_idx` ON `book_reports` (`book_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `book_reports_one_open_per_user_book` ON `book_reports` (`reporter_id`,`book_id`) WHERE "book_reports"."status" = 'open';