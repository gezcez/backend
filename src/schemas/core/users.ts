// users.ts

import { sql } from "drizzle-orm"
import { index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export type UserStatus = "active" | "banned" | "pending_deletion" | "deleted"
export type Locale = "tr" | "en"
export type PasswordAlgo = "argon2id" | "bcrypt"

export const usersTable = sqliteTable(
	"users",
	{
		id: int().primaryKey({ autoIncrement: true }),
		/** ULID, the JWT `sub` and the only id clients ever see. */
		public_id: text().notNull(),
		/** Always lowercased. */
		email: text().notNull(),
		email_verified_at: int({ mode: "timestamp_ms" }),
		/** Not collected at sign-up; kept for legacy imports and later handles. */
		username: text(),
		display_name: text().notNull(),
		locale: text().$type<Locale>().notNull().default("tr"),
		password_hash: text(),
		password_algo: text().$type<PasswordAlgo>(),
		password_updated_at: int({ mode: "timestamp_ms" }),
		terms_version: text(),
		privacy_version: text(),
		terms_accepted_at: int({ mode: "timestamp_ms" }),
		status: text().$type<UserStatus>().notNull().default("active"),
		banned_until: int({ mode: "timestamp_ms" }),
		deletion_due_at: int({ mode: "timestamp_ms" }),
		last_login_at: int({ mode: "timestamp_ms" }),
		created_at: int({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		updated_at: int({ mode: "timestamp_ms" }),
	},
	(t) => [
		uniqueIndex("users_public_id_unique").on(t.public_id),
		uniqueIndex("users_email_unique").on(t.email),
		uniqueIndex("users_username_unique")
			.on(sql`${t.username} COLLATE NOCASE`)
			.where(sql`${t.username} IS NOT NULL`),
		index("users_status_idx").on(t.status),
	],
)

export type UserRow = typeof usersTable.$inferSelect
export type NewUserRow = typeof usersTable.$inferInsert
