import { int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const ratelimitsTable = sqliteTable(
	"ratelimits",
	{
		identifier: text().notNull(),
		created_at: int({ mode: "timestamp_ms" }).notNull().defaultNow(),
		args: text({ mode: "json" }).notNull(),
	},
	(table) => [
		uniqueIndex("ratelimits_table_unique_index").on(
			table.identifier,
			table.created_at
		),
	]
)
