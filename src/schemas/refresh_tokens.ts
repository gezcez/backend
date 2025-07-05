import { int, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { TABLE_ACTIONS } from "./users"

export const refreshTokensTable = sqliteTable("refresh_tokens", {
	id:text().notNull().primaryKey().unique(),
	created_at:TABLE_ACTIONS.created_at,
	created_by:TABLE_ACTIONS.created_by,
	updated_at:TABLE_ACTIONS.updated_at,
	is_invalid:int({mode:"boolean"}),
	args: text({mode:"json"}).$type<{
		
	}>()
})
