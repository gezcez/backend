PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	FOREIGN KEY (`app`) REFERENCES `apps`(`key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_permissions`("id", "app", "key", "description", "type", "created_by", "updated_by", "created_at", "updated_at") SELECT "id", "app", "key", "description", "type", "created_by", "updated_by", "created_at", "updated_at" FROM `permissions`;--> statement-breakpoint
DROP TABLE `permissions`;--> statement-breakpoint
ALTER TABLE `__new_permissions` RENAME TO `permissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_key_unique` ON `permissions` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_unique_index` ON `permissions` (`app`,`key`);