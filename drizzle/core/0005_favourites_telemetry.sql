CREATE TABLE `favourite_groups` (
	`user_id` integer NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`position` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `favourites_state` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `favourites` (
	`user_id` integer NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`network_id` integer NOT NULL,
	`ref_id` text NOT NULL,
	`label` text NOT NULL,
	`direction` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `favourites_user_updated_idx` ON `favourites` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `telemetry_counters` (
	`day` text NOT NULL,
	`platform` text NOT NULL,
	`app_version` text NOT NULL,
	`city_slug` text NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`day`, `platform`, `app_version`, `city_slug`, `key`)
);
