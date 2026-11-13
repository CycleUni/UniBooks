CREATE TABLE `student_id_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`region_code` text NOT NULL,
	`school_id` integer NOT NULL,
	`student_number` text NOT NULL,
	`image_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reject_reason` text DEFAULT '' NOT NULL,
	`reviewed_by_id` text,
	`reviewed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `student_id_verifications_region_status_created_idx` ON `student_id_verifications` (`region_code`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `student_id_verifications_user_idx` ON `student_id_verifications` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `student_id_verifications_one_pending_per_user_region` ON `student_id_verifications` (`user_id`,`region_code`) WHERE "student_id_verifications"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `student_id_verifications_one_approved_per_school_number` ON `student_id_verifications` (`school_id`,`student_number`) WHERE "student_id_verifications"."status" = 'approved';--> statement-breakpoint
ALTER TABLE `region_verifications` ADD `method` text;--> statement-breakpoint
ALTER TABLE `region_verifications` ADD `student_number` text;--> statement-breakpoint
ALTER TABLE `schools` ADD `allows_student_id_verification` integer DEFAULT 0 NOT NULL;