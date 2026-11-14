CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`listing_id` text,
	`listing_ref` text NOT NULL,
	`book_title` text DEFAULT '' NOT NULL,
	`book_isbn` text DEFAULT '' NOT NULL,
	`price` integer NOT NULL,
	`buyer_id` text NOT NULL,
	`is_open` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_listing_id_idx` ON `order_items` (`listing_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_items_open_buyer_listing_uniq` ON `order_items` (`listing_id`,`buyer_id`) WHERE is_open = 1;--> statement-breakpoint
INSERT OR IGNORE INTO `order_items` (`id`, `order_id`, `listing_id`, `listing_ref`, `book_title`, `book_isbn`, `price`, `buyer_id`, `is_open`, `created_at`)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  `id`,
  `listing_id`,
  COALESCE(`listing_ref`, `listing_id`, `id`),
  `book_title`,
  `book_isbn`,
  `total_amount`,
  `buyer_id`,
  CASE WHEN `status` IN ('pending', 'accepted', 'handed_over') THEN 1 ELSE 0 END,
  `created_at`
FROM `orders`;
