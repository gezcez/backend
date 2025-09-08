import { index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { TABLE_ACTIONS } from "@gezcez/core"
import { usersTable } from "./users"
import { networksTable } from "./networks"

export const rolesTable = sqliteTable("roles", {
	id: int().primaryKey({ autoIncrement: true }).unique().notNull(),
	description: text(),
	name: text().notNull().unique(),
	level: int().notNull().default(0),
	immutable: int({ mode: "boolean" }).default(false),
	...TABLE_ACTIONS,
})

export const userRolesTable = sqliteTable(
	"user_roles",
	{
		id: int().primaryKey({ autoIncrement: true }),
		user_id: int()
			.references(() => usersTable.id)
			.notNull(),
		role_id: int()
			.references(() => rolesTable.id)
			.notNull(),
		status: int({ mode: "boolean" }).default(false).notNull(),
		network_id: int()
			.references(() => networksTable.id)
			.notNull(),
		...TABLE_ACTIONS,
	},
	(table) => [
		index("user_roles_idx").on(table.user_id,table.network_id, table.role_id),
		uniqueIndex("user_roles_unique_index").on(
			table.user_id,
			table.role_id,
			table.network_id
		),
	]
)
