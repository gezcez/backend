CREATE TABLE `active_versions` (
	`binding_id` integer PRIMARY KEY NOT NULL,
	`version_id` integer NOT NULL,
	`activated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feed_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`binding_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'building' NOT NULL,
	`source_hash` text,
	`stats` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `feed_versions_binding_idx` ON `feed_versions` (`binding_id`,`id`);--> statement-breakpoint
CREATE TABLE `service_exceptions` (
	`binding_id` integer NOT NULL,
	`date` text NOT NULL,
	`service_external_id` text NOT NULL,
	`type` text NOT NULL,
	`note` text,
	PRIMARY KEY(`binding_id`, `date`, `service_external_id`)
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`binding_id` integer NOT NULL,
	`version_id` integer,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`counts` text,
	`warnings` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_binding_idx` ON `sync_runs` (`binding_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `agencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`binding_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`url` text,
	`phone` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agencies_version_ext_unique` ON `agencies` (`version_id`,`binding_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `pattern_stops` (
	`version_id` integer NOT NULL,
	`pattern_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`stop_id` integer NOT NULL,
	`offset_s` integer,
	`dist_m` integer,
	PRIMARY KEY(`version_id`, `pattern_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `pattern_stops_version_stop_idx` ON `pattern_stops` (`version_id`,`stop_id`);--> statement-breakpoint
CREATE TABLE `patterns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`route_id` integer NOT NULL,
	`direction` integer NOT NULL,
	`headsign` text NOT NULL,
	`external_ref` text NOT NULL,
	`shape` text NOT NULL,
	`length_m` integer DEFAULT 0 NOT NULL,
	`stop_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `patterns_version_route_idx` ON `patterns` (`version_id`,`route_id`,`direction`);--> statement-breakpoint
CREATE TABLE `routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`binding_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`short_name` text NOT NULL,
	`long_name` text NOT NULL,
	`route_type` integer DEFAULT 3 NOT NULL,
	`color` text,
	`text_color` text,
	`agency_id` integer,
	`is_public` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routes_version_ext_unique` ON `routes` (`version_id`,`binding_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `routes_version_short_idx` ON `routes` (`version_id`,`binding_id`,`short_name`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`binding_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`days_mask` integer NOT NULL,
	`label` text,
	`start_date` text,
	`end_date` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_version_ext_unique` ON `services` (`version_id`,`binding_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `stops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`binding_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`lat_e6` integer NOT NULL,
	`lon_e6` integer NOT NULL,
	`cell` integer NOT NULL,
	`wheelchair` integer,
	`parent_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stops_version_ext_unique` ON `stops` (`version_id`,`binding_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `stops_version_cell_idx` ON `stops` (`version_id`,`cell`);--> statement-breakpoint
CREATE TABLE `trips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`pattern_id` integer NOT NULL,
	`service_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`start_time_s` integer NOT NULL,
	`headsign` text,
	`color` text
);
--> statement-breakpoint
CREATE INDEX `trips_version_pattern_idx` ON `trips` (`version_id`,`pattern_id`,`service_id`,`start_time_s`);--> statement-breakpoint
CREATE INDEX `trips_version_ext_idx` ON `trips` (`version_id`,`external_id`);