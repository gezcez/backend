CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`log_key` text NOT NULL,
	`app_key` text NOT NULL,
	`description` text NOT NULL,
	`props` text,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `logs_id_unique` ON `logs` (`id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`provider_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_type` text,
	`provider_url` text,
	`overrides` text,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_provider_id_unique` ON `providers` (`provider_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_permissions` (
	`user_id` integer NOT NULL,
	`permission_id` integer NOT NULL,
	`status` integer DEFAULT false NOT NULL,
	`scope` integer NOT NULL,
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
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `user_permissions_idx` ON `user_permissions` (`user_id`,`permission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_permissions_unique_index` ON `user_permissions` (`user_id`,`permission_id`,`scope`);--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text(20) NOT NULL,
	`email` text(255) NOT NULL,
	`password` text(255) NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	`is_activated` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "email", "password", "created_at", "updated_at", "is_activated") SELECT "id", "username", "email", "password", "created_at", "updated_at", "is_activated" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);