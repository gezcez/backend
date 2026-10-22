// passkeys.ts
// WebAuthn credentials (plan section 5.1, P5) and the single-use challenges behind them.

import { index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { usersTable } from "./users"

export const passkeysTable = sqliteTable(
	"passkeys",
	{
		/** `pk_` + ULID, handed to the UI. */
		id: text().primaryKey(),
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		/** base64url credential id from the authenticator. */
		credential_id: text().notNull(),
		/** base64url COSE public key. */
		public_key: text().notNull(),
		sign_count: int().notNull().default(0),
		transports: text({ mode: "json" }).$type<string[]>().notNull(),
		name: text().notNull(),
		/** Device label of the browser that registered it ("iPhone", "Mac"). */
		device_hint: text(),
		aaguid: text(),
		/** Synced (multi-device) credential. */
		backed_up: int({ mode: "boolean" }).notNull().default(false),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
		last_used_at: int({ mode: "timestamp_ms" }),
	},
	(t) => [
		uniqueIndex("passkeys_credential_id_unique").on(t.credential_id),
		index("passkeys_user_idx").on(t.user_id),
	],
)

export type PasskeyRow = typeof passkeysTable.$inferSelect
export type NewPasskeyRow = typeof passkeysTable.$inferInsert

export type WebauthnChallengeKind = "registration" | "signin" | "reauth"

export const webauthnChallengesTable = sqliteTable(
	"webauthn_challenges",
	{
		/** `wc_` + ULID: the `challenge_id` handed to the UI. */
		id: text().primaryKey(),
		kind: text().$type<WebauthnChallengeKind>().notNull(),
		/** base64url challenge. */
		challenge: text().notNull(),
		/** Registration and re-auth: the user the ceremony belongs to. */
		user_id: int(),
		/** Registration and re-auth: the session that asked. */
		session_id: text(),
		/** sha256 of the device cookie that asked. */
		device_id_hash: text(),
		auth_request_id: text(),
		expires_at: int({ mode: "timestamp_ms" }).notNull(),
		consumed_at: int({ mode: "timestamp_ms" }),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
	},
	(t) => [index("webauthn_challenges_expires_idx").on(t.expires_at)],
)

export type WebauthnChallengeRow = typeof webauthnChallengesTable.$inferSelect
