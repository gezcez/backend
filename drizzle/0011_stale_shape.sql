PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_apps` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sensitive` integer NOT NULL,
	`refresh_token_ttl` integer NOT NULL,
	`access_token_ttl` integer NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_apps`("key", "name", "sensitive", "refresh_token_ttl", "access_token_ttl", "created_by", "updated_by", "created_at", "updated_at") SELECT "key", "name", "sensitive", "refresh_token_ttl", "access_token_ttl", "created_by", "updated_by", "created_at", "updated_at" FROM `apps`;--> statement-breakpoint
DROP TABLE `apps`;--> statement-breakpoint
ALTER TABLE `__new_apps` RENAME TO `apps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `apps_key_unique` ON `apps` (`key`);--> statement-breakpoint
CREATE TABLE `__new_networks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`country` text NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_networks`("id", "name", "country", "created_by", "updated_by", "created_at", "updated_at") SELECT "id", "name", "country", "created_by", "updated_by", "created_at", "updated_at" FROM `networks`;--> statement-breakpoint
DROP TABLE `networks`;--> statement-breakpoint
ALTER TABLE `__new_networks` RENAME TO `networks`;--> statement-breakpoint
CREATE UNIQUE INDEX `networks_name_unique` ON `networks` (`name`);--> statement-breakpoint
CREATE TABLE `__new_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app` text NOT NULL,
	`key` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'scoped' NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	FOREIGN KEY (`app`) REFERENCES `apps`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_permissions`("id", "app", "key", "description", "type", "created_by", "updated_by", "created_at", "updated_at") SELECT "id", "app", "key", "description", "type", "created_by", "updated_by", "created_at", "updated_at" FROM `permissions`;--> statement-breakpoint
DROP TABLE `permissions`;--> statement-breakpoint
ALTER TABLE `__new_permissions` RENAME TO `permissions`;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_key_unique` ON `permissions` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_unique_index` ON `permissions` (`app`,`key`);--> statement-breakpoint
CREATE TABLE `__new_user_permissions` (
	`user_id` integer NOT NULL,
	`permission_id` integer,
	`status` integer DEFAULT false NOT NULL,
	`scope` integer,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope`) REFERENCES `networks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_user_permissions`("user_id", "permission_id", "status", "scope", "created_by", "updated_by", "created_at", "updated_at") SELECT "user_id", "permission_id", "status", "scope", "created_by", "updated_by", "created_at", "updated_at" FROM `user_permissions`;--> statement-breakpoint
DROP TABLE `user_permissions`;--> statement-breakpoint
ALTER TABLE `__new_user_permissions` RENAME TO `user_permissions`;--> statement-breakpoint
CREATE INDEX `user_permissions_idx` ON `user_permissions` (`user_id`,`permission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_permissions_unique_index` ON `user_permissions` (`user_id`,`permission_id`,`scope`);