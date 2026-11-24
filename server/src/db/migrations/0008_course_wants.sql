CREATE TABLE `course_wants` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`user_id` text NOT NULL,
	`school_id` integer NOT NULL,
	`course_key` text NOT NULL,
	`course_name` text NOT NULL,
	`notified_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `course_wants_school_course_idx` ON `course_wants` (`school_id`,`course_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `course_wants_user_school_course_unique` ON `course_wants` (`user_id`,`school_id`,`course_key`);