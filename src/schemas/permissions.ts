import { index, sqliteTable, int, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { usersTable } from "./users";
import { appsTable } from "./apps";
import { networksTable } from "./networks";
import { rolesTable } from "./roles";
import { TABLE_ACTIONS } from "@common/utils";


export const permissionsTable = sqliteTable("permissions", {
	id: int().primaryKey({ autoIncrement: true }).notNull(),
	app: text().references(() => appsTable.key).notNull(),
	key: text().unique().notNull(),
	page_label:text(),
	page_href:text(),
	created_at:TABLE_ACTIONS.created_at,
}, (table) => [
	uniqueIndex("permissions_unique_index").on(table.app, table.key)]
)
export const permissionPathRegistryTable = sqliteTable("permission_path_matrix",{
	id: int().primaryKey({ autoIncrement: true }).notNull(),
	permission_id: int().references(()=>permissionsTable.id),
	path:text().notNull(),
	description: text(),
	method: text().notNull(),
	type: text().$type<"scoped" | "global">().default("scoped").notNull(),
	created_at:TABLE_ACTIONS.created_at,
	updated_at:TABLE_ACTIONS.updated_at,
	sudo_mode:int({mode:"boolean"}).notNull()
},(table)=>[uniqueIndex("permissions_path_matrix_unique").on(table.path,table.method)])

export const userPermissionsTable = sqliteTable("user_permissions", {
	id:int().primaryKey({autoIncrement:true}),
	user_id: int().references(() => usersTable.id).notNull(),
	permission_id: int().references(() => permissionsTable.id).notNull(),
	status: int({ mode: "boolean" }).default(false).notNull(),
	network_id: int().references(()=>networksTable.id).notNull(),
	...TABLE_ACTIONS
}, (table) => [
	index("user_permissions_idx").on(table.user_id,table.network_id, table.permission_id),
	uniqueIndex("user_permissions_unique_index").on(table.user_id,table.permission_id,table.network_id)
])

export const rolePermissionsTable = sqliteTable("role_permissions", {
	id:int().primaryKey({autoIncrement:true}),
	role_id: int().references(() => rolesTable.id).notNull(),
	permission_id: int().references(() => permissionsTable.id).notNull(),
	...TABLE_ACTIONS
}, (table) => [
	index("role_permissions_idx").on(table.role_id, table.permission_id),
	uniqueIndex("role_permissions_unique_index").on(table.role_id,table.permission_id)
])