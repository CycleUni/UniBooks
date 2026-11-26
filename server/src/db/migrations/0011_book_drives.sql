CREATE TABLE `book_drive_staff` (
	`drive_id` text NOT NULL,
	`user_id` text NOT NULL,
	`added_by_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`drive_id`, `user_id`),
	FOREIGN KEY (`drive_id`) REFERENCES `book_drives`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `book_drive_staff_user_idx` ON `book_drive_staff` (`user_id`);--> statement-breakpoint
CREATE TABLE `book_drives` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`region_code` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'intake' NOT NULL,
	`claim_opens_at` text,
	`claim_closes_at` text,
	`pickup_starts_at` text,
	`pickup_ends_at` text,
	`max_claims_per_user` integer DEFAULT 3 NOT NULL,
	`member_priority` integer DEFAULT 1 NOT NULL,
	`allocation_seed` text,
	`allocated_at` text,
	`closed_at` text,
	`next_shelf_no` integer DEFAULT 1 NOT NULL,
	`created_by_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `book_drives_organization_idx` ON `book_drives` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `drive_copies` (
	`id` text PRIMARY KEY NOT NULL,
	`drive_id` text NOT NULL,
	`book_id` text NOT NULL,
	`shelf_no` integer NOT NULL,
	`condition` text NOT NULL,
	`donor_student_number` text DEFAULT '' NOT NULL,
	`donor_department` text DEFAULT '' NOT NULL,
	`target_department` text DEFAULT '' NOT NULL,
	`target_grade` integer,
	`status` text DEFAULT 'in_stock' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`intake_by_id` text,
	`picked_up_at` text,
	`picked_up_by_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`drive_id`) REFERENCES `book_drives`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intake_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`picked_up_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `drive_copies_drive_book_status_idx` ON `drive_copies` (`drive_id`,`book_id`,`status`);--> statement-breakpoint
CREATE INDEX `drive_copies_book_idx` ON `drive_copies` (`book_id`);--> statement-breakpoint
CREATE INDEX `drive_copies_drive_donor_idx` ON `drive_copies` (`drive_id`,`donor_student_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `drive_copies_drive_shelf_unique` ON `drive_copies` (`drive_id`,`shelf_no`);