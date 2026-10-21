CREATE TABLE `notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notify_log_key_uq` ON `notification_log` (`user_id`,`key`);--> statement-breakpoint
CREATE INDEX `notify_log_user_idx` ON `notification_log` (`user_id`,`sent_at`);--> statement-breakpoint
CREATE TABLE `price_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`target_micros` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`triggered_at` integer,
	`triggered_price_micros` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `price_alerts_user_idx` ON `price_alerts` (`user_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `price_series` (
	`symbol` text NOT NULL,
	`series` text NOT NULL,
	`points` text NOT NULL,
	`prev_close_micros` integer,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`symbol`, `series`)
);
--> statement-breakpoint
CREATE TABLE `watchlist` (
	`user_id` text NOT NULL,
	`symbol` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `symbol`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `cards` ADD `autopay_account_id` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `autopay_currency` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `autopay_mode` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `autopay_since` text;--> statement-breakpoint
ALTER TABLE `credit_statements` ADD `autopay_at` integer;--> statement-breakpoint
ALTER TABLE `securities` ADD `prev_close_micros` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `original_amount` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `original_currency` text;