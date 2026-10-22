ALTER TABLE `account_deletions` ADD `tombstone` text;--> statement-breakpoint
ALTER TABLE `data_exports` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `data_exports` ADD `downloaded_at` integer;