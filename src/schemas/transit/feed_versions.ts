// feed_versions.ts
// Versioned static data per binding (plan 5.2). A sync writes a full new version, validates it
// and flips active_versions in one transaction; readers always join through active_versions.

import { index, int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export type FeedVersionStatus = "building" | "active" | "superseded" | "failed"

export const feedVersionsTable = sqliteTable(
	"feed_versions",
	{
		id: int().primaryKey({ autoIncrement: true }),
		binding_id: int().notNull(),
		started_at: int({ mode: "timestamp_ms" }).notNull(),
		finished_at: int({ mode: "timestamp_ms" }),
		status: text().$type<FeedVersionStatus>().notNull().default("building"),
		source_hash: text(),
		stats: text({ mode: "json" }).$type<Record<string, number>>(),
		error: text(),
	},
	(t) => [index("feed_versions_binding_idx").on(t.binding_id, t.id)],
)

export const activeVersionsTable = sqliteTable("active_versions", {
	binding_id: int().primaryKey(),
	version_id: int().notNull(),
	activated_at: int({ mode: "timestamp_ms" }).notNull(),
})

export type SyncRunStatus = "running" | "ok" | "unchanged" | "failed"

export const syncRunsTable = sqliteTable(
	"sync_runs",
	{
		id: int().primaryKey({ autoIncrement: true }),
		binding_id: int().notNull(),
		version_id: int(),
		trigger: text().$type<"schedule" | "manual" | "boot">().notNull(),
		started_at: int({ mode: "timestamp_ms" }).notNull(),
		finished_at: int({ mode: "timestamp_ms" }),
		status: text().$type<SyncRunStatus>().notNull().default("running"),
		counts: text({ mode: "json" }).$type<Record<string, number>>(),
		warnings: text({ mode: "json" }).$type<string[]>(),
		error: text(),
	},
	(t) => [index("sync_runs_binding_idx").on(t.binding_id, t.started_at)],
)

export const serviceExceptionsTable = sqliteTable(
	"service_exceptions",
	{
		binding_id: int().notNull(),
		/** YYYY-MM-DD local date. */
		date: text().notNull(),
		service_external_id: text().notNull(),
		type: text().$type<"added" | "removed">().notNull(),
		note: text(),
	},
	(t) => [primaryKey({ columns: [t.binding_id, t.date, t.service_external_id] })],
)

export type FeedVersionRow = typeof feedVersionsTable.$inferSelect
export type SyncRunRow = typeof syncRunsTable.$inferSelect
