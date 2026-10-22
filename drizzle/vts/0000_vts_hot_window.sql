CREATE TABLE `archive_manifest` (
	`binding_id` integer NOT NULL,
	`date` text NOT NULL,
	`dataset` text NOT NULL,
	`rows` integer NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`path` text NOT NULL,
	`exported_at` integer NOT NULL,
	`uploaded_at` integer,
	`verified_at` integer,
	PRIMARY KEY(`binding_id`, `date`, `dataset`)
);
--> statement-breakpoint
CREATE TABLE `polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`binding_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`url_variant` text,
	`http_status` integer,
	`outcome` text NOT NULL,
	`feed_ts` integer,
	`entities` integer DEFAULT 0 NOT NULL,
	`accepted` integer DEFAULT 0 NOT NULL,
	`inserted` integer DEFAULT 0 NOT NULL,
	`dropped` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `polls_binding_idx` ON `polls` (`binding_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `positions` (
	`vehicle_id` integer NOT NULL,
	`vehicle_ts` integer NOT NULL,
	`feed_ts` integer NOT NULL,
	`binding_id` integer NOT NULL,
	`route_ext` text,
	`direction` integer,
	`trip_ext` text,
	`stop_ext` text,
	`stop_seq` integer,
	`status` integer,
	`lat_e6` integer NOT NULL,
	`lon_e6` integer NOT NULL,
	`bearing_d10` integer,
	`speed_cms` integer,
	`quality` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`vehicle_id`, `vehicle_ts`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `positions_binding_feed_idx` ON `positions` (`binding_id`,`feed_ts`);--> statement-breakpoint
CREATE TABLE `provider_tokens` (
	`realm` text PRIMARY KEY NOT NULL,
	`access_token_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`refreshed_at` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trip_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`binding_id` integer NOT NULL,
	`vehicle_id` integer NOT NULL,
	`route_ext` text,
	`direction` integer,
	`trip_ext` text,
	`keyed_by_route` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`first_stop_seq` integer,
	`last_stop_seq` integer,
	`max_stop_seq` integer,
	`samples` integer DEFAULT 1 NOT NULL,
	`scheduled_start_s` integer,
	`start_delay_s` integer
);
--> statement-breakpoint
CREATE INDEX `trip_runs_route_idx` ON `trip_runs` (`binding_id`,`route_ext`,`direction`,`started_at`);--> statement-breakpoint
CREATE INDEX `trip_runs_vehicle_idx` ON `trip_runs` (`vehicle_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `trip_runs_open_idx` ON `trip_runs` (`binding_id`) WHERE "trip_runs"."ended_at" IS NULL;--> statement-breakpoint
CREATE TABLE `vehicle_state` (
	`vehicle_id` integer PRIMARY KEY NOT NULL,
	`binding_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`plate` text,
	`label` text,
	`vehicle_ts` integer NOT NULL,
	`feed_ts` integer NOT NULL,
	`lat_e6` integer NOT NULL,
	`lon_e6` integer NOT NULL,
	`bearing_d10` integer,
	`speed_cms` integer,
	`route_ext` text,
	`direction` integer,
	`trip_ext` text,
	`stop_ext` text,
	`stop_seq` integer,
	`status` integer,
	`quality` integer DEFAULT 0 NOT NULL,
	`live` integer DEFAULT 1 NOT NULL,
	`open_run_id` integer,
	`run_trip_ext` text,
	`run_route_ext` text,
	`run_direction` integer,
	`run_started_at` integer,
	`run_last_ts` integer,
	`run_first_stop_seq` integer,
	`run_last_stop_seq` integer,
	`run_samples` integer,
	`last_seen_feed_ts` integer NOT NULL,
	`missing_polls` integer DEFAULT 0 NOT NULL,
	`max_stop_seq` integer,
	`updated_poll_id` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vehicle_state_binding_idx` ON `vehicle_state` (`binding_id`);--> statement-breakpoint
CREATE INDEX `vehicle_state_poll_idx` ON `vehicle_state` (`updated_poll_id`);--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`binding_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`plate` text,
	`label` text,
	`kind_flags` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vehicles_binding_ext_unique` ON `vehicles` (`binding_id`,`external_id`);