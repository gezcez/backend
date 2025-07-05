import { index, int, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { TABLE_ACTIONS } from "./users"

export const moderationLogs = sqliteTable("moderation_logs", {
	id: int().primaryKey({ autoIncrement: true }).primaryKey().unique(),
	created_at: TABLE_ACTIONS.created_at,
	created_by: TABLE_ACTIONS.created_by,
	target_user_id: int().notNull(),
	action: text({enum:["ban","unban"]}).notNull(),
	public_reason: text(),
	private_reason: text(),
	args: text({ mode: "json" }).$type<{}>(),
},(table)=>[
	index("moderation_logs_created_at_index").on(table.created_at),
	index("moderation_logs_moderator_index").on(table.created_by,table.created_at),
	index("moderation_target_user_index").on(table.target_user_id,table.created_at),
])
