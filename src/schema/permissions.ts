import { index, sqliteTable, int, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { usersTable,TABLE_ACTIONS } from "./users";
import { appsTable } from "./apps";
import { networksTable } from "./networks";


export const permissionsTable = sqliteTable("permissions", {
	id: int().primaryKey({ autoIncrement: true }).notNull(),
	app: text().references(() => appsTable.key).notNull(),
	key: text().unique().notNull(),
	description: text(),
	requires_sudo_mode:int({mode:"boolean"}).default(false).notNull(),
	always_check_in_db:int({mode:"boolean"}).default(false).notNull(),
	type: text().$type<"scoped" | "global">().default("scoped").notNull(),
	...TABLE_ACTIONS
}, (table) => [
	uniqueIndex("permissions_unique_index").on(table.app, table.key)]
)


export const userPermissionsTable = sqliteTable("user_permissions", {
	id:int().primaryKey({autoIncrement:true}),
	user_id: int().references(() => usersTable.id).notNull(),
	permission_id: int().references(() => permissionsTable.id).notNull(),
	status: int({ mode: "boolean" }).default(false).notNull(),
	network_id: int().references(()=>networksTable.id).notNull(),
	...TABLE_ACTIONS
}, (table) => [
	index("user_permissions_idx").on(table.user_id, table.permission_id),
	uniqueIndex("user_permissions_unique_index").on(table.user_id,table.permission_id,table.network_id)
])