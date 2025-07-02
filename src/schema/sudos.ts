import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { TABLE_ACTIONS } from "./users"

export const sudosTable = sqliteTable(
	"sudos",
	{
		sudo_key: text().primaryKey().notNull().unique(),
		created_at: TABLE_ACTIONS.created_at,
		created_by: TABLE_ACTIONS.created_by,
		updated_at: TABLE_ACTIONS.updated_at,
		linked_refresh_token_id: text().notNull(),
		confirm_hash: text().notNull()
	},
	(table) => [index("sudos_table_index").on(table.sudo_key)]
)
