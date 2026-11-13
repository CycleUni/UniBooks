CREATE TABLE `user_schools` (
	`user_id` text NOT NULL,
	`region_code` text NOT NULL,
	`school_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `region_code`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`region_code`) REFERENCES `regions`(`code`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `schools` ADD `requires_verification` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `school_prompted_at` text;--> statement-breakpoint
INSERT OR IGNORE INTO `user_schools` (`user_id`, `region_code`, `school_id`, `created_at`, `updated_at`)
SELECT `user_id`, `region_code`, `school_id`, COALESCE(`verified_at`, `created_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), COALESCE(`verified_at`, `created_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM `region_verifications`
WHERE `is_active` = 1
  AND `school_id` IS NOT NULL
  AND `verified_at` IS NOT NULL
  AND (`expires_at` IS NULL OR `expires_at` > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
UPDATE `users` SET `school_prompted_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `school_prompted_at` IS NULL AND `id` IN (SELECT `user_id` FROM `user_schools`);
