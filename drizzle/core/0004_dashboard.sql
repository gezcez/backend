CREATE TABLE `account_deletions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`requested_at` integer NOT NULL,
	`delete_after` integer NOT NULL,
	`cancelled_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `account_deletions_user_idx` ON `account_deletions` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `account_deletions_due_idx` ON `account_deletions` (`delete_after`) WHERE "account_deletions"."cancelled_at" IS NULL AND "account_deletions"."completed_at" IS NULL;--> statement-breakpoint
CREATE TABLE `data_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`file_path` text,
	`size_bytes` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`ready_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_exports_user_idx` ON `data_exports` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `data_exports_status_idx` ON `data_exports` (`status`);--> statement-breakpoint
CREATE TABLE `flags` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`network_overrides` text DEFAULT '{}' NOT NULL,
	`updated_by` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_key` text NOT NULL,
	`trigger` text NOT NULL,
	`started_by` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`rows` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `job_runs_key_started_idx` ON `job_runs` (`job_key`,`started_at`);--> statement-breakpoint
ALTER TABLE `apps` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `platform` text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `secret_prefix` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `secret_created_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `secret_last_used_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `previous_secret_prefix` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `previous_secret_created_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `previous_secret_last_used_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `refresh_max_s` integer DEFAULT 15552000 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_suppressions` ADD `email_masked` text;--> statement-breakpoint
ALTER TABLE `email_suppressions` ADD `detail` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `updated_at` integer;--> statement-breakpoint
CREATE INDEX `emails_user_idx` ON `emails` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `permissions` ADD `last_seen_at` integer;--> statement-breakpoint
UPDATE `apps` SET `platform` = 'dev' WHERE `dev` = 1;