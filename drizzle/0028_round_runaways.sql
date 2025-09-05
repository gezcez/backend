CREATE TABLE `permission_path_matrix` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`permission_id` integer,
	`path` text NOT NULL,
	`description` text,
	`method` text NOT NULL,
	`type` text DEFAULT 'scoped' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	`sudo_mode` integer NOT NULL,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_path_matrix_unique` ON `permission_path_matrix` (`path`,`method`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role_id` integer NOT NULL,
	`permission_id` integer NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `role_permissions_idx` ON `role_permissions` (`role_id`,`permission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_permissions_unique_index` ON `role_permissions` (`role_id`,`permission_id`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`description` text,
	`name` text NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_id_unique` ON `roles` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`role_id` integer NOT NULL,
	`status` integer DEFAULT false NOT NULL,
	`network_id` integer NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `user_roles_idx` ON `user_roles` (`user_id`,`network_id`,`role_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_unique_index` ON `user_roles` (`user_id`,`role_id`,`network_id`);--> statement-breakpoint
DROP INDEX `user_permissions_idx`;--> statement-breakpoint
CREATE INDEX `user_permissions_idx` ON `user_permissions` (`user_id`,`network_id`,`permission_id`);--> statement-breakpoint
ALTER TABLE `logs` ADD `updated_by` integer;--> statement-breakpoint
ALTER TABLE `logs` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `networks` ADD `provider_id` integer REFERENCES providers(id);--> statement-breakpoint
ALTER TABLE `networks` ADD `network_id_defined_by_provider` text;--> statement-breakpoint
ALTER TABLE `networks` ADD `network_public_secret` text;--> statement-breakpoint
ALTER TABLE `networks` ADD `hide` integer DEFAULT true;--> statement-breakpoint
ALTER TABLE `permissions` ADD `page_label` text;--> statement-breakpoint
ALTER TABLE `permissions` ADD `page_href` text;--> statement-breakpoint
ALTER TABLE `permissions` DROP COLUMN `description`;--> statement-breakpoint
ALTER TABLE `permissions` DROP COLUMN `type`;--> statement-breakpoint
ALTER TABLE `permissions` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `permissions` DROP COLUMN `updated_by`;--> statement-breakpoint
ALTER TABLE `permissions` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `providers` ADD `name` text;--> statement-breakpoint
ALTER TABLE `providers` ADD `pulled_data` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `type`;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `overrides`;