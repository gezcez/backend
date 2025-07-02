CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`created_by` integer NOT NULL,
	`updated_at` integer,
	`is_invalid` integer,
	`args` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_id_unique` ON `refresh_tokens` (`id`);