CREATE TABLE `apps` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sensitive` integer NOT NULL,
	`refresh_token_ttl` integer NOT NULL,
	`access_token_ttl` integer NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_key_unique` ON `apps` (`key`);--> statement-breakpoint
CREATE TABLE `networks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`country` text NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `permissions` ADD `app` text REFERENCES apps(key);--> statement-breakpoint
ALTER TABLE `permissions` ADD `type` text DEFAULT 'scoped' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_unique_index` ON `permissions` (`app`,`key`);--> statement-breakpoint
ALTER TABLE `user_permissions` ADD `scope` integer REFERENCES networks(id);--> statement-breakpoint
CREATE UNIQUE INDEX `user_permissions_unique_index` ON `user_permissions` (`user_id`,`permission_id`,`scope`);