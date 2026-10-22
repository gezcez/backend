// sessions.ts
// Identity (SSO) sessions behind the __Host-gz_session cookie. Only hashes are stored.

import { index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { AuthMethod } from "@common/jwt.types"
import { usersTable } from "./users"

export type SessionRevokeReason =
	| "logout"
	| "logout_device"
	| "user_revoked"
	| "admin_revoked"
	| "password_reset"
	| "reuse_detected"
	| "ban"
	| "deletion"
	| "replaced"

export const sessionsTable = sqliteTable(
	"sessions",
	{
		/** ULID; the `sid` claim. */
		id: text().primaryKey(),
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		token_hash: text().notNull(),
		/** sha256 of the __Host-gz_device value. */
		device_id_hash: text().notNull(),
		auth_time: int({ mode: "timestamp_ms" }).notNull(),
		amr: text({ mode: "json" }).$type<AuthMethod[]>().notNull(),
		user_agent: text(),
		device_label: text(),
		ip_prefix: text(),
		approx_location: text(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
		last_seen_at: int({ mode: "timestamp_ms" }).notNull(),
		/** Sliding expiry (30 d). */
		expires_at: int({ mode: "timestamp_ms" }).notNull(),
		/** Hard cap (90 d). */
		absolute_expires_at: int({ mode: "timestamp_ms" }).notNull(),
		/** Set on sign-out; the row stays for the device account chooser. */
		signed_out_at: int({ mode: "timestamp_ms" }),
		revoked_at: int({ mode: "timestamp_ms" }),
		/** Removed from this device's account chooser ("forget this account"). */
		forgotten_at: int({ mode: "timestamp_ms" }),
		revoke_reason: text().$type<SessionRevokeReason>(),
	},
	(t) => [
		uniqueIndex("sessions_token_hash_unique").on(t.token_hash),
		index("sessions_user_revoked_idx").on(t.user_id, t.revoked_at),
		index("sessions_device_idx").on(t.device_id_hash),
	],
)

export type SessionRow = typeof sessionsTable.$inferSelect
