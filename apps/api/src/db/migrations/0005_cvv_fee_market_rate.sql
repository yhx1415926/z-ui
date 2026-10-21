ALTER TABLE `cards` ADD `cvv_enc` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `market_rate` real;--> statement-breakpoint
ALTER TABLE `transactions` ADD `fee_of` text;--> statement-breakpoint
CREATE INDEX `tx_fee_of_idx` ON `transactions` (`fee_of`);