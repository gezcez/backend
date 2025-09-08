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

	static async getUserHighestRoleLevel(user_id: number, network_id: number): Promise<number> {
		const user_roles = await db
			.select({
				role: rolesTable
			})
			.from(userRolesTable)
			.leftJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
			.where(
				and(
					eq(userRolesTable.user_id, user_id),
					eq(userRolesTable.network_id, network_id),
					eq(userRolesTable.status, true)
				)
			)

		// Return the highest role level (roles with higher numbers have more authority)
		return Math.max(...user_roles.map(({ role }) => role?.level ?? 0), 0)
	}

	static async hasProtectedRole(user_id: number, network_id: number): Promise<boolean> {
		const user_roles = await db
			.select({
				role: rolesTable
			})
			.from(userRolesTable)
			.leftJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
			.where(
				and(
					eq(userRolesTable.user_id, user_id),
					eq(userRolesTable.network_id, network_id),
					eq(userRolesTable.status, true)
				)
			)

		// Check if user has network_admin or root role
		return user_roles.some(({ role }) => 
			role?.name === "network_admin" || 
			role?.name === "root" ||
			role?.name === "admin"
		)
	}

	static async canEditUser(executor_id: number, target_user_id: number, network_id: number): Promise<[boolean, string | undefined]> {
		try {
			// Get executor's highest role level
			const executorLevel = await UserRepository.getUserHighestRoleLevel(executor_id, network_id)
			
			// Get target user's highest role level
			const targetLevel = await UserRepository.getUserHighestRoleLevel(target_user_id, network_id)
			
			// Check if target user has protected roles (admin/root/network_admin)
			const targetHasProtected = await UserRepository.hasProtectedRole(target_user_id, network_id)
			if (targetHasProtected) {
				return [false, "Cannot modify roles for users with admin/root privileges"]
			}
			
			// Executor cannot edit users with higher or equal role levels
			if (targetLevel >= executorLevel && targetLevel > 0) {
				return [false, "Cannot modify roles for users with higher or equal authority level"]
			}
			
			return [true, undefined]
		} catch (error) {
			return [false, `Error checking user permissions: ${error instanceof Error ? error.message : String(error)}`]
		}
	}

	static async addRoleToUser(params: {
		user_id: number
		role_id: number
		network_id: number
		executor_id: number
	}): Promise<[any, string | undefined]> {
		const { user_id, role_id, network_id, executor_id } = params

		try {
			// Check if executor can edit this user based on role hierarchy
			const [canEdit, editError] = await UserRepository.canEditUser(executor_id, user_id, network_id)
			if (!canEdit) {
				return [null, editError]
			}

			// Check if role assignment already exists
			const existing = await db
				.select()
				.from(userRolesTable)
				.where(
					and(
						eq(userRolesTable.user_id, user_id),
						eq(userRolesTable.role_id, role_id),
						eq(userRolesTable.network_id, network_id)
					)
				)

			if (existing.length > 0) {
				// If exists but inactive, reactivate it
				if (!existing[0].status) {
					const [updated] = await db
						.update(userRolesTable)
						.set({
							status: true,
							updated_at: new Date(),
							updated_by: executor_id
						})
						.where(eq(userRolesTable.id, existing[0].id))
						.returning()
					return [updated, undefined]
				}
				return [null, "Role already assigned to user"]
			}

			// Create new role assignment
			const [created] = await db
				.insert(userRolesTable)
				.values({
					user_id,
					role_id,
					network_id,
					status: true,
					created_by: executor_id,
					updated_by: executor_id,
					created_at: new Date(),
					updated_at: new Date()
				})
				.returning()

			return [created, undefined]
		} catch (error) {
			return [null, `Database error: ${error instanceof Error ? error.message : String(error)}`]
		}
	}

	static async removeRoleFromUser(params: {
		user_id: number
		role_id: number
		network_id: number
		executor_id: number
	}): Promise<[any, string | undefined]> {
		const { user_id, role_id, network_id, executor_id } = params

		try {
			// Check if executor can edit this user based on role hierarchy
			const [canEdit, editError] = await UserRepository.canEditUser(executor_id, user_id, network_id)
			if (!canEdit) {
				return [null, editError]
			}

			// Find the role assignment
			const existing = await db
				.select()
				.from(userRolesTable)
				.where(
					and(
						eq(userRolesTable.user_id, user_id),
						eq(userRolesTable.role_id, role_id),
						eq(userRolesTable.network_id, network_id),
						eq(userRolesTable.status, true)
					)
				)

			if (existing.length === 0) {
				return [null, "Role assignment not found"]
			}

			// Deactivate the role assignment
			const [updated] = await db
				.update(userRolesTable)
				.set({
					status: false,
					updated_at: new Date(),
					updated_by: executor_id
				})
				.where(eq(userRolesTable.id, existing[0].id))
				.returning()

			return [updated, undefined]
		} catch (error) {
			return [null, `Database error: ${error instanceof Error ? error.message : String(error)}`]
		}
	}
}
