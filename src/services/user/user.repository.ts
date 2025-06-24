import { and, eq } from "drizzle-orm"
import {
	permissionsTable,
	userPermissionsTable,
} from "../../schema/permissions"
import { db } from "../../util"
import { usersTable } from "../../schema/users"

export abstract class UserRepository {
	static async getUserPermissions(user_id: number) {
		const result = await db
			.select({
				user_permission: userPermissionsTable,
				permission_details: permissionsTable,
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
		return result.filter((e) =>
			e.permission_details?.type === "global"
				? e.user_permission.network_id === 0
				: true
		)
	}
	static async getUserPermissionsByAppKey(user_id: number, app_key: string) {
		const result = await db
			.select({
				user_permission: userPermissionsTable,
				permission_details: permissionsTable,
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

		return result.filter(
			(e) =>
				e.permission_details?.app === app_key &&
				(e.permission_details?.type === "global"
					? e.user_permission.network_id === 0
					: true)
		)
	}
}
