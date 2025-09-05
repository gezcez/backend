CREATE TABLE `matrix_planets_main` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`planet_type` text NOT NULL,
	`population` integer DEFAULT 0 NOT NULL,
	`is_habitable` integer DEFAULT false NOT NULL,
	`discovered_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`config` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matrix_planets_main_id_unique` ON `matrix_planets_main` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `matrix_planets_main_key_unique` ON `matrix_planets_main` (`key`);--> statement-breakpoint
CREATE TABLE `matrix_planets_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_id` integer NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`description` text,
	`changes` text,
	FOREIGN KEY (`target_id`) REFERENCES `matrix_planets_main`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matrix_planets_logs_id_unique` ON `matrix_planets_logs` (`id`);