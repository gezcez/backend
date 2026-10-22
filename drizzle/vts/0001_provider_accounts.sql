CREATE TABLE `inbound_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL,
	`to_addr` text NOT NULL,
	`from_addr` text NOT NULL,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`consumed_at` integer,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbound_emails_to_idx` ON `inbound_emails` (`to_addr`,`received_at`);--> statement-breakpoint
CREATE INDEX `inbound_emails_expires_idx` ON `inbound_emails` (`expires_at`);--> statement-breakpoint
CREATE TABLE `provider_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`realm` text NOT NULL,
	`provider` text NOT NULL,
	`email` text NOT NULL,
	`password_enc` text,
	`refresh_token_enc` text,
	`state` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`registered_at` integer,
	`last_login_at` integer,
	`last_refresh_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`retired_at` integer
);
--> statement-breakpoint
CREATE INDEX `provider_accounts_realm_idx` ON `provider_accounts` (`realm`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_accounts_email_unique` ON `provider_accounts` (`provider`,`email`);