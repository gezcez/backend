CREATE TABLE `apps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`client_secret_hash` text,
	`previous_secret_hash` text,
	`previous_secret_expires_at` integer,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text NOT NULL,
	`allowed_scopes` text NOT NULL,
	`first_party` integer DEFAULT false NOT NULL,
	`system` integer DEFAULT false NOT NULL,
	`dev` integer DEFAULT false NOT NULL,
	`refresh_cookie` integer DEFAULT false NOT NULL,
	`access_ttl_s` integer DEFAULT 900 NOT NULL,
	`refresh_ttl_s` integer DEFAULT 2592000 NOT NULL,
	`logo_url` text,
	`homepage_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` integer,
	`updated_at` integer,
	`updated_by` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_client_id_unique` ON `apps` (`client_id`);--> statement-breakpoint
CREATE TABLE `grants` (
	`user_id` integer NOT NULL,
	`client_id` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer,
	PRIMARY KEY(`user_id`, `client_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `grants_client_idx` ON `grants` (`client_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor_user_id` integer,
	`actor_client_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`network_id` integer,
	`request_id` text,
	`ip_hash` text,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_user_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_network_idx` ON `audit_log` (`network_id`,`at`);--> statement-breakpoint
CREATE TABLE `cities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`country_code` text DEFAULT 'TR' NOT NULL,
	`timezone` text DEFAULT 'Europe/Istanbul' NOT NULL,
	`center_lat_e6` integer,
	`center_lon_e6` integer,
	`bbox` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cities_slug_unique` ON `cities` (`slug`);--> statement-breakpoint
CREATE TABLE `networks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`city_id` integer NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`operator_name` text,
	`color` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` integer,
	`updated_at` integer,
	`updated_by` integer,
	`deleted_at` integer,
	FOREIGN KEY (`city_id`) REFERENCES `cities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `networks_slug_unique` ON `networks` (`slug`);--> statement-breakpoint
CREATE INDEX `networks_city_idx` ON `networks` (`city_id`);--> statement-breakpoint
CREATE TABLE `email_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`flow_id` text NOT NULL,
	`email` text NOT NULL,
	`intent` text NOT NULL,
	`user_id` integer,
	`auth_request_id` text,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`sends` integer DEFAULT 1 NOT NULL,
	`resend_available_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`ip_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_codes_flow_id_unique` ON `email_codes` (`flow_id`);--> statement-breakpoint
CREATE INDEX `email_codes_email_intent_idx` ON `email_codes` (`email`,`intent`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_codes_ip_idx` ON `email_codes` (`ip_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	`removed_by` integer,
	`removed_reason` text
);
--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer,
	`to_email` text NOT NULL,
	`template` text NOT NULL,
	`locale` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_message_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `emails_status_idx` ON `emails` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`state` text NOT NULL,
	`code_challenge` text NOT NULL,
	`prompt` text,
	`max_age` integer,
	`login_hint` text,
	`ui_locales` text,
	`device_id_hash` text NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_requests_expires_idx` ON `auth_requests` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`auth_request_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`code_challenge` text NOT NULL,
	`auth_time` integer NOT NULL,
	`amr` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`family_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_expires_idx` ON `oauth_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`parent_id` text,
	`user_id` integer NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`replaced_by` text,
	`replaced_at` integer,
	`revoked_at` integer,
	`revoke_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_hash_unique` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_family_idx` ON `refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_user_client_idx` ON `refresh_tokens` (`user_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_session_idx` ON `refresh_tokens` (`session_id`);--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`public_reason` text,
	`private_reason` text,
	`expires_at` integer,
	`created_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `moderation_actions_target_idx` ON `moderation_actions` (`target_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `permission_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`permission_key` text NOT NULL,
	`scope` text NOT NULL,
	`sudo` integer DEFAULT false NOT NULL,
	`description` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_routes_method_path_unique` ON `permission_routes` (`method`,`path`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`description` text NOT NULL,
	`sudo` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`orphaned_at` integer
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` integer NOT NULL,
	`permission_key` text NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`role_id`, `permission_key`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`level` integer NOT NULL,
	`immutable` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` integer,
	`updated_at` integer,
	`updated_by` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_key_unique` ON `roles` (`key`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`role_id` integer NOT NULL,
	`network_id` integer,
	`network_key` integer GENERATED ALWAYS AS (ifnull(network_id, 0)) VIRTUAL,
	`granted_by` integer,
	`granted_at` integer NOT NULL,
	`revoked_by` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_active_unique` ON `user_roles` (`user_id`,`role_id`,`network_key`) WHERE "user_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `user_roles_network_idx` ON `user_roles` (`network_id`);--> statement-breakpoint
CREATE INDEX `user_roles_user_idx` ON `user_roles` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`device_id_hash` text NOT NULL,
	`auth_time` integer NOT NULL,
	`amr` text NOT NULL,
	`user_agent` text,
	`device_label` text,
	`ip_prefix` text,
	`approx_location` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`signed_out_at` integer,
	`revoked_at` integer,
	`revoke_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_revoked_idx` ON `sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `sessions_device_idx` ON `sessions` (`device_id_hash`);--> statement-breakpoint
CREATE TABLE `signing_keys` (
	`kid` text PRIMARY KEY NOT NULL,
	`alg` text NOT NULL,
	`public_jwk` text NOT NULL,
	`private_jwk_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	`active_from` integer NOT NULL,
	`retire_after` integer
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`email` text NOT NULL,
	`email_verified_at` integer,
	`username` text,
	`display_name` text NOT NULL,
	`locale` text DEFAULT 'tr' NOT NULL,
	`password_hash` text,
	`password_algo` text,
	`password_updated_at` integer,
	`terms_version` text,
	`privacy_version` text,
	`terms_accepted_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`banned_until` integer,
	`deletion_due_at` integer,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_public_id_unique` ON `users` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` ("username" COLLATE NOCASE) WHERE "users"."username" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);