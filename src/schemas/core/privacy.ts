// privacy.ts
// Account data exports and deletion requests (plan section 6.1.7).

import { sql } from "drizzle-orm"
import { index, int, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { usersTable } from "./users"

export type DataExportStatus = "queued" | "ready" | "failed" | "expired"

export const dataExportsTable = sqliteTable(
	"data_exports",
	{
		/** `exp_` + ULID */
		id: text().primaryKey(),
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		status: text().$type<DataExportStatus>().notNull().default("queued"),
		/** Relative to DATA_DIR. */
		file_path: text(),
		size_bytes: int(),
		error: text(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
		ready_at: int({ mode: "timestamp_ms" }),
		/** Download window end (7 days after ready); the file is deleted after it. */
		expires_at: int({ mode: "timestamp_ms" }),
	},
	(t) => [
		index("data_exports_user_idx").on(t.user_id, t.created_at),
		index("data_exports_status_idx").on(t.status),
	],
)

export type DataExportRow = typeof dataExportsTable.$inferSelect

/**
 * One row per deletion request. `user_id` has no foreign key: completed rows outlive the user
 * and keep only dates.
 */
export const accountDeletionsTable = sqliteTable(
	"account_deletions",
	{
		id: int().primaryKey({ autoIncrement: true }),
		user_id: int().notNull(),
		requested_at: int({ mode: "timestamp_ms" }).notNull(),
		delete_after: int({ mode: "timestamp_ms" }).notNull(),
		cancelled_at: int({ mode: "timestamp_ms" }),
		completed_at: int({ mode: "timestamp_ms" }),
	},
	(t) => [
		index("account_deletions_user_idx").on(t.user_id, t.requested_at),
		index("account_deletions_due_idx")
			.on(t.delete_after)
			.where(sql`${t.cancelled_at} IS NULL AND ${t.completed_at} IS NULL`),
	],
)

export type AccountDeletionRow = typeof accountDeletionsTable.$inferSelect
