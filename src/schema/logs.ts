import { index, int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { TABLE_ACTIONS } from "./users"

export const logsTable = sqliteTable("logs",
	{
		id: int().primaryKey({ autoIncrement: true }).notNull().unique(),
		log_key: text().notNull(),
		app_key: text().notNull(),
		description: text().notNull(),
		props: text({ mode: "json" }).$type<{
			ip: string
			args: any
		}>(),
		created_by:TABLE_ACTIONS.created_by,
		created_at:TABLE_ACTIONS.created_at,
	},
	// (table) => [index("roles_table_user_id_created_at_index").on(table.created_by, table.created_at)]
)
