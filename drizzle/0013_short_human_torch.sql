ALTER TABLE `providers` RENAME COLUMN "provider_id" TO "id";--> statement-breakpoint
ALTER TABLE `providers` RENAME COLUMN "provider_type" TO "type";--> statement-breakpoint
ALTER TABLE `providers` RENAME COLUMN "provider_url" TO "url";--> statement-breakpoint
DROP INDEX `providers_provider_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `providers_id_unique` ON `providers` (`id`);