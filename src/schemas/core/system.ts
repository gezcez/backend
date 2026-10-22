// system.ts
// Feature flags and settings (definitions live in code, values here) and the job run history.

import { index, int, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const flagsTable = sqliteTable("flags", {
	/** A key from src/services/flags/flag-definitions.ts; `settings.*` keys back the settings page. */
	key: text().primaryKey(),
	value: text({ mode: "json" }).$type<unknown>().notNull(),
	/** Network id (as a string) to value. */
	network_overrides: text({ mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	updated_by: int(),
	updated_at: int({ mode: "timestamp_ms" }).notNull(),
})

export type FlagRow = typeof flagsTable.$inferSelect

export type JobTrigger = "schedule" | "manual"
export type JobRunStatus = "running" | "succeeded" | "failed"

export const jobRunsTable = sqliteTable(
	"job_runs",
	{
		id: int().primaryKey({ autoIncrement: true }),
		job_key: text().notNull(),
		trigger: text().$type<JobTrigger>().notNull(),
		started_by: int(),
		started_at: int({ mode: "timestamp_ms" }).notNull(),
		finished_at: int({ mode: "timestamp_ms" }),
		status: text().$type<JobRunStatus>().notNull(),
		/** Rows or items the run touched, when the job reports it. */
		rows: int(),
		error: text(),
	},
	(t) => [index("job_runs_key_started_idx").on(t.job_key, t.started_at)],
)

export type JobRunRow = typeof jobRunsTable.$inferSelect
