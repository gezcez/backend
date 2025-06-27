CREATE TABLE `ratelimits` (
	`identifier` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`args` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ratelimits_table_unique_index` ON `ratelimits` (`identifier`,`created_at`);