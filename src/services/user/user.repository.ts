import { and, eq } from "drizzle-orm"
import { db } from "../../db"

import { RolesRepository } from "../roles/roles.repository"
import {
	moderationLogs,
	permissionsTable,
	rolesTable,
	userPermissionsTable,
	userRolesTable,
	usersTable
} from "@schemas"
import { SYNCED_CONFIG } from "@common/utils"
export abstract class UserRepository {
	static async getUserPermissions(user_id: number) {
		const result = await db
			.select({
				user_permission: userPermissionsTable,
				permission_details: permissionsTable
			})
			.from(userPermissionsTable)
			.where(
				and(
					eq(userPermissionsTable.user_id, user_id),
					eq(userPermissionsTable.status, true)
				)
			)
			.leftJoin(
				permissionsTable,
				eq(permissionsTable.id, userPermissionsTable.permission_id)
			)
		return result
	}

	static async listUserRoles(user_id: number) {
		const result = await db
			.select()
			.from(userRolesTable)
			.where(
				and(
					eq(userRolesTable.user_id, user_id),
					eq(userRolesTable.status, true)
				)
			)
		return result
	}

	static async listUserRolesWithLeftJoin(user_id: number) {
		const result = await db
			.select({
				user_role: userRolesTable,
				role: rolesTable
			})
			.from(userRolesTable)
			.where(
				and(
					eq(userRolesTable.user_id, user_id),
					eq(userRolesTable.status, true)
				)
			)
			.leftJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
		return result
	}

	static async listUserAppsWithLeftJoin(user_id: number) {
		const result = await db.select({}).from(userRolesTable)
	}

	static async listUserPermissionsByUserRoles(user_id: number) {
		const user_roles = await UserRepository.listUserRolesWithLeftJoin(user_id)
		const role_permissions = user_roles.map(({ role, user_role }) => ({
			role: role,
			user_role: user_role,
			role_permissions: SYNCED_CONFIG.role_permissions.filter(
				(e) => e.role_id === role?.id
			)
		}))

		const all_permissions = role_permissions.reduce(
			(p, n) => p.concat(...n.role_permissions),
			[] as any
		)
	}

	static async listUserPermissionsByUserPermissions(user_id: number) {
		const result = await db
			.select()
			.from(userPermissionsTable)
			.where(
				and(
					eq(userPermissionsTable.status, true),
					eq(userPermissionsTable.user_id, user_id)
				)
			)
		const to_return = result.map((e) => ({
			permission: SYNCED_CONFIG.permissions.find(
				(p) => p.id === e.permission_id
			),
			user_permission: e
		}))
		return to_return
	}
	static async getUserPermissionsByAppKey(user_id: number, app_key: string) {
		const result = await db
			.select({
				user_permission: userPermissionsTable,
				permission_details: permissionsTable
			})
			.from(userPermissionsTable)
			.where(
				and(
					eq(userPermissionsTable.user_id, user_id),
					eq(userPermissionsTable.status, true)
				)
			)
			.leftJoin(
				permissionsTable,
				eq(permissionsTable.id, userPermissionsTable.permission_id)
			)

		return result.filter((e) => e.permission_details?.app === app_key)
	}

	static async activateUser(user_id: number) {
		const [updated_user] = await db
			.update(usersTable)
			.set({
				activated_at: new Date()
			})
			.where(eq(usersTable.id, user_id))
			.returning()
		return updated_user
	}
	static async getUserBanRecordFromRecordId(record_id: number) {
		const found = await db
			.select()
			.from(moderationLogs)
			.where(and(eq(moderationLogs.id, record_id)))
		return found[0]
	}

	static async listAllUsers() {
		const users = await db
			.select({
				id: usersTable.id,
				username: usersTable.username,
				email: usersTable.email,
				created_at: usersTable.created_at,
				updated_at: usersTable.updated_at,
				activated_at: usersTable.activated_at,
				ban_record: usersTable.ban_record,
			})
			.from(usersTable)
			.orderBy(usersTable.created_at)
		return users
	}

	static async getUserRoleMatrix(filter_users?: number[]) {
		const query = db
			.select({
				user_role: userRolesTable,
				user: {
					id: usersTable.id,
					username: usersTable.username
				},
				role: rolesTable,
			})
			.from(userRolesTable)
			.leftJoin(usersTable, eq(usersTable.id, userRolesTable.user_id))
			.leftJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
			.where(eq(userRolesTable.status, true))

		if (filter_users && filter_users.length > 0) {
			const result = await query
			return result.filter((row) => filter_users.includes(row.user_role.user_id))
		}

		return await query
	}
}
