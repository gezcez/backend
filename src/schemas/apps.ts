import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { TABLE_ACTIONS } from "./users";

export const appsTable = sqliteTable("apps", {
	key: text().notNull().primaryKey().unique(),
	name: text().notNull(),
	sensitive: int({ mode: "boolean" }).notNull(),
	refresh_token_ttl: int().notNull(),
	access_token_ttl: int().notNull(),
	// access_permission: int().references(() => permissionsTable.id).notNull(),
	...TABLE_ACTIONS
})