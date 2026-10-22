// apps.ts
// OAuth clients and the consent memory (grants).

import { index, int, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { auditColumns } from "../_audit"
import { usersTable } from "./users"

export type AppType = "public" | "confidential"
export type AppStatus = "active" | "disabled"
/** web: browser clients; native: mobile apps (custom schemes); dev: loopback on any port. */
export type AppPlatform = "web" | "native" | "dev"

export const appsTable = sqliteTable(
	"apps",
	{
		id: int().primaryKey({ autoIncrement: true }),
		client_id: text().notNull(),
		name: text().notNull(),
		description: text().notNull().default(""),
		type: text().$type<AppType>().notNull(),
		platform: text().$type<AppPlatform>().notNull().default("web"),
		client_secret_hash: text(),
		/** First characters of the secret, shown in the dashboard to tell secrets apart. */
		secret_prefix: text(),
		secret_created_at: int({ mode: "timestamp_ms" }),
		secret_last_used_at: int({ mode: "timestamp_ms" }),
		previous_secret_hash: text(),
		previous_secret_prefix: text(),
		previous_secret_created_at: int({ mode: "timestamp_ms" }),
		previous_secret_last_used_at: int({ mode: "timestamp_ms" }),
		previous_secret_expires_at: int({ mode: "timestamp_ms" }),
		redirect_uris: text({ mode: "json" }).$type<string[]>().notNull(),
		post_logout_redirect_uris: text({ mode: "json" }).$type<string[]>().notNull(),
		allowed_scopes: text({ mode: "json" }).$type<string[]>().notNull(),
		first_party: int({ mode: "boolean" }).notNull().default(false),
		/** Cannot be deleted from the dashboard (dashboard, mobile). */
		system: int({ mode: "boolean" }).notNull().default(false),
		/** Allows http://localhost:<any port> for registered loopback URIs. */
		dev: int({ mode: "boolean" }).notNull().default(false),
		/** First-party web client: refresh token travels in the gz_rt cookie. */
		refresh_cookie: int({ mode: "boolean" }).notNull().default(false),
		access_ttl_s: int().notNull().default(900),
		refresh_ttl_s: int().notNull().default(2_592_000),
		/** Hard cap on a refresh family's age, however often it rotates. */
		refresh_max_s: int().notNull().default(15_552_000),
		logo_url: text(),
		homepage_url: text(),
		status: text().$type<AppStatus>().notNull().default("active"),
		...auditColumns(),
	},
	(t) => [uniqueIndex("apps_client_id_unique").on(t.client_id)],
)

export type AppRow = typeof appsTable.$inferSelect

export const grantsTable = sqliteTable(
	"grants",
	{
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		client_id: text().notNull(),
		scopes: text({ mode: "json" }).$type<string[]>().notNull(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
		updated_at: int({ mode: "timestamp_ms" }).notNull(),
		revoked_at: int({ mode: "timestamp_ms" }),
	},
	(t) => [
		primaryKey({ columns: [t.user_id, t.client_id] }),
		index("grants_client_idx").on(t.client_id),
	],
)

export type GrantRow = typeof grantsTable.$inferSelect
