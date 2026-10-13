DROP INDEX `listings_book_id_idx`;--> statement-breakpoint
CREATE INDEX `listings_book_status_created_idx` ON `listings` (`book_id`,`status`,`created_at`);