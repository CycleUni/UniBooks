CREATE TABLE `drive_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`drive_id` text NOT NULL,
	`book_id` text NOT NULL,
	`user_id` text NOT NULL,
	`student_number` text DEFAULT '' NOT NULL,
	`department` text DEFAULT '' NOT NULL,
	`grade` integer,
	`is_member` integer DEFAULT 0 NOT NULL,
	`score` integer,
	`rank` integer,
	`status` text DEFAULT 'registered' NOT NULL,
	`copy_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`drive_id`) REFERENCES `book_drives`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`copy_id`) REFERENCES `drive_copies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `drive_claims_drive_book_status_idx` ON `drive_claims` (`drive_id`,`book_id`,`status`);--> statement-breakpoint
CREATE INDEX `drive_claims_user_idx` ON `drive_claims` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `drive_claims_drive_user_book_unique` ON `drive_claims` (`drive_id`,`user_id`,`book_id`);