PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_networks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`country` text NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_networks`("id", "label", "country", "created_by", "updated_by", "created_at", "updated_at") SELECT "id", "label", "country", "created_by", "updated_by", "created_at", "updated_at" FROM `networks`;--> statement-breakpoint
DROP TABLE `networks`;--> statement-breakpoint
ALTER TABLE `__new_networks` RENAME TO `networks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `networks_label_unique` ON `networks` (`label`);