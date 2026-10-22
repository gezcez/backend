CREATE TABLE `provider_bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`network_id` integer NOT NULL,
	`provider_key` text NOT NULL,
	`external_ref` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`poll_interval_s` integer DEFAULT 30 NOT NULL,
	`idle_poll_interval_s` integer DEFAULT 60 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`disabled_reason` text,
	`created_at` integer NOT NULL,
	`created_by` integer,
	`updated_at` integer,
	`updated_by` integer,
	`deleted_at` integer,
	FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_key`) REFERENCES `providers`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_bindings_provider_ref_unique` ON `provider_bindings` (`provider_key`,`external_ref`);--> statement-breakpoint
CREATE INDEX `provider_bindings_network_idx` ON `provider_bindings` (`network_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`image_url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`disabled_reason` text,
	`pulled_data` text DEFAULT '[]' NOT NULL,
	`legal_note` text,
	`created_at` integer NOT NULL,
	`created_by` integer,
	`updated_at` integer,
	`updated_by` integer,
	`deleted_at` integer
);
