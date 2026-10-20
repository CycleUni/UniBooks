ALTER TABLE `orders` ADD `handed_over_at` text;--> statement-breakpoint
-- Orders already handed over: updated_at is the best record of when (it was the auto-complete base until now).
UPDATE `orders` SET `handed_over_at` = `updated_at` WHERE `status` = 'handed_over';
