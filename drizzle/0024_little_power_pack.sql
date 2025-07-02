ALTER TABLE `users` RENAME COLUMN "banned_at" TO "ban_record";--> statement-breakpoint
CREATE TABLE `moderation_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`created_by` integer NOT NULL,
	`target_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`public_reason` text,
	`private_reason` text,
	`args` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `moderation_logs_id_unique` ON `moderation_logs` (`id`);--> statement-breakpoint
CREATE INDEX `moderation_logs_created_at_index` ON `moderation_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_logs_moderator_index` ON `moderation_logs` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_target_user_index` ON `moderation_logs` (`target_user_id`,`created_at`);