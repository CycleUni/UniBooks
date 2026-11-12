ALTER TABLE `schools` ADD `email_domains` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `schools` ADD `student_email_domain` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `schools` ADD `google_domains` text DEFAULT '[]' NOT NULL;