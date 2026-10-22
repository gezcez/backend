// rbac.ts
// Permissions (rebuilt from code at boot), roles with levels, and network-scoped assignments.

import { sql } from "drizzle-orm"
import { index, int, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { auditColumns } from "../_audit"
import { networksTable } from "./catalog"
import { usersTable } from "./users"

export type PermissionScope = "global" | "network"

export const permissionsTable = sqliteTable("permissions", {
	key: text().primaryKey(),
	scope: text().$type<PermissionScope>().notNull(),
	description: text().notNull(),
	sudo: int({ mode: "boolean" }).notNull().default(false),
	first_seen_at: int({ mode: "timestamp_ms" }).notNull(),
	/** Last boot that found the key in code. */
	last_seen_at: int({ mode: "timestamp_ms" }),
	orphaned_at: int({ mode: "timestamp_ms" }),
})

export const permissionRoutesTable = sqliteTable(
	"permission_routes",
	{
		id: int().primaryKey({ autoIncrement: true }),
		method: text().notNull(),
		path: text().notNull(),
		permission_key: text()
			.notNull()
			.references(() => permissionsTable.key, { onDelete: "cascade" }),
		scope: text().$type<PermissionScope>().notNull(),
		sudo: int({ mode: "boolean" }).notNull().default(false),
		description: text().notNull(),
		updated_at: int({ mode: "timestamp_ms" }).notNull(),
	},
	(t) => [uniqueIndex("permission_routes_method_path_unique").on(t.method, t.path)],
)

export const rolesTable = sqliteTable(
	"roles",
	{
		id: int().primaryKey({ autoIncrement: true }),
		key: text().notNull(),
		name: text().notNull(),
		description: text(),
		level: int().notNull(),
		immutable: int({ mode: "boolean" }).notNull().default(false),
		...auditColumns(),
	},
	(t) => [uniqueIndex("roles_key_unique").on(t.key)],
)

export const rolePermissionsTable = sqliteTable(
	"role_permissions",
	{
		role_id: int()
			.notNull()
			.references(() => rolesTable.id, { onDelete: "cascade" }),
		permission_key: text()
			.notNull()
			.references(() => permissionsTable.key, { onDelete: "cascade" }),
		created_by: int(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.role_id, t.permission_key] })],
)

export const userRolesTable = sqliteTable(
	"user_roles",
	{
		id: int().primaryKey({ autoIncrement: true }),
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		role_id: int()
			.notNull()
			.references(() => rolesTable.id, { onDelete: "cascade" }),
		/** NULL means global. */
		network_id: int().references(() => networksTable.id, { onDelete: "cascade" }),
		/** 0 for global grants, so the partial unique index treats NULL as a value. */
		network_key: int().generatedAlwaysAs(sql`ifnull(network_id, 0)`, { mode: "virtual" }),
		granted_by: int(),
		granted_at: int({ mode: "timestamp_ms" }).notNull(),
		revoked_by: int(),
		revoked_at: int({ mode: "timestamp_ms" }),
	},
	(t) => [
		uniqueIndex("user_roles_active_unique")
			.on(t.user_id, t.role_id, t.network_key)
			.where(sql`${t.revoked_at} IS NULL`),
		index("user_roles_network_idx").on(t.network_id),
		index("user_roles_user_idx").on(t.user_id),
	],
)

export const moderationActionsTable = sqliteTable(
	"moderation_actions",
	{
		id: int().primaryKey({ autoIncrement: true }),
		target_user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		action: text().$type<"ban" | "unban" | "warn" | "note">().notNull(),
		public_reason: text(),
		private_reason: text(),
		expires_at: int({ mode: "timestamp_ms" }),
		created_by: int(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
	},
	(t) => [index("moderation_actions_target_idx").on(t.target_user_id, t.created_at)],
)

export type RoleRow = typeof rolesTable.$inferSelect
export type PermissionRow = typeof permissionsTable.$inferSelect
export type UserRoleRow = typeof userRolesTable.$inferSelect
export type ModerationActionRow = typeof moderationActionsTable.$inferSelect
