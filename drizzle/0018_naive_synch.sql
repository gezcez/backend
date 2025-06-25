PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_emails` (
	`uuid` text PRIMARY KEY NOT NULL,
	`target_user_id` integer NOT NULL,
	`content` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_emails`("uuid", "target_user_id", "content", "type", "created_at") SELECT "uuid", "target_user_id", "content", "type", "created_at" FROM `emails`;--> statement-breakpoint
DROP TABLE `emails`;--> statement-breakpoint
ALTER TABLE `__new_emails` RENAME TO `emails`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `emails_uuid_unique` ON `emails` (`uuid`);--> statement-breakpoint
CREATE INDEX `emails_id_index` ON `emails` (`uuid`);