PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_permissions` (
	`user_id` integer NOT NULL,
	`status` integer DEFAULT false NOT NULL,
	`created_by` integer NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_user_permissions`("user_id", "status", "created_by", "updated_by", "created_at", "updated_at") SELECT "user_id", "status", "created_by", "updated_by", "created_at", "updated_at" FROM `user_permissions`;--> statement-breakpoint
DROP TABLE `user_permissions`;--> statement-breakpoint
ALTER TABLE `__new_user_permissions` RENAME TO `user_permissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;