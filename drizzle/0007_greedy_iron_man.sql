ALTER TABLE `networks` ADD `label` text;--> statement-breakpoint
CREATE UNIQUE INDEX `networks_label_unique` ON `networks` (`label`);