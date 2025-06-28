CREATE TABLE `sudos` (
	`sudo_key` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`created_by` integer NOT NULL,
	`updated_at` integer,
	`linked_refresh_token_id` text NOT NULL,
	`confirm_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sudos_sudo_key_unique` ON `sudos` (`sudo_key`);--> statement-breakpoint
CREATE INDEX `sudos_table_index` ON `sudos` (`sudo_key`);