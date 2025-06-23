ALTER TABLE `networks` RENAME COLUMN "label" TO "name";--> statement-breakpoint
DROP INDEX `networks_label_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `networks_name_unique` ON `networks` (`name`);