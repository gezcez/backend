// oauth.ts
// Server-side authorization requests, authorization codes and refresh token families.

import { index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { AuthMethod } from "@common/jwt.types"
import { usersTable } from "./users"

export type AuthRequestStatus = "pending" | "completed" | "denied" | "expired"

export const authRequestsTable = sqliteTable(
	"auth_requests",
	{
		/** `ar_` + ULID */
		id: text().primaryKey(),
		client_id: text().notNull(),
		redirect_uri: text().notNull(),
		scope: text().notNull(),
		state: text().notNull(),
		code_challenge: text().notNull(),
		prompt: text(),
		max_age: int(),
		login_hint: text(),
		ui_locales: text(),
		device_id_hash: text().notNull(),
		/** The session chosen on continue (account chooser). */
		session_id: text(),
		status: text().$type<AuthRequestStatus>().notNull().default("pending"),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
		expires_at: int({ mode: "timestamp_ms" }).notNull(),
	},
	(t) => [index("auth_requests_expires_idx").on(t.expires_at)],
)

export type AuthRequestRow = typeof authRequestsTable.$inferSelect

export const oauthCodesTable = sqliteTable(
	"oauth_codes",
	{
		code_hash: text().primaryKey(),
		client_id: text().notNull(),
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		session_id: text().notNull(),
		auth_request_id: text().notNull(),
		redirect_uri: text().notNull(),
		scope: text().notNull(),
		code_challenge: text().notNull(),
		auth_time: int({ mode: "timestamp_ms" }).notNull(),
		amr: text({ mode: "json" }).$type<AuthMethod[]>().notNull(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
		expires_at: int({ mode: "timestamp_ms" }).notNull(),
		consumed_at: int({ mode: "timestamp_ms" }),
		/** Refresh family issued from this code, revoked if the code is replayed. */
		family_id: text(),
	},
	(t) => [index("oauth_codes_expires_idx").on(t.expires_at)],
)

export type OAuthCodeRow = typeof oauthCodesTable.$inferSelect

export type RefreshRevokeReason =
	| "rotated"
	| "reuse_detected"
	| "logout"
	| "ban"
	| "user_revoked"
	| "app_revoked"
	| "admin_revoked"
	| "max_age"
	| "session_revoked"
	| "code_replayed"
	| "password_reset"

export const refreshTokensTable = sqliteTable(
	"refresh_tokens",
	{
		/** ULID */
		id: text().primaryKey(),
		family_id: text().notNull(),
		token_hash: text().notNull(),
		parent_id: text(),
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		client_id: text().notNull(),
		session_id: text().notNull(),
		scope: text().notNull(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
		expires_at: int({ mode: "timestamp_ms" }).notNull(),
		last_used_at: int({ mode: "timestamp_ms" }),
		replaced_by: text(),
		/** Start of the rotation grace window. */
		replaced_at: int({ mode: "timestamp_ms" }),
		revoked_at: int({ mode: "timestamp_ms" }),
		revoke_reason: text().$type<RefreshRevokeReason>(),
	},
	(t) => [
		uniqueIndex("refresh_tokens_token_hash_unique").on(t.token_hash),
		index("refresh_tokens_family_idx").on(t.family_id),
		index("refresh_tokens_user_client_idx").on(t.user_id, t.client_id),
		index("refresh_tokens_session_idx").on(t.session_id),
	],
)

export type RefreshTokenRow = typeof refreshTokensTable.$inferSelect
