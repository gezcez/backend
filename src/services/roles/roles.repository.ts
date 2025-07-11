import {
	logger,
	networksTable,
	ProperPromise,
	rolePermissionsTable,
	rolesTable,
	SYNCED_CONFIG,
	userRolesTable,
} from "@shared"
import { db } from "../../db"
import { and, eq } from "drizzle-orm"

export abstract class RolesRepository {
	static async listUserNetworks(user_id: number) {
		const results = await db
			.select({
				network: {
					id: networksTable.id,
					name: networksTable.name,
				},
			})
			.from(userRolesTable)
			.where(and(eq(userRolesTable.status, true), eq(userRolesTable.user_id, user_id)))
			.groupBy(userRolesTable.network_id)
			.leftJoin(networksTable, eq(networksTable.id, userRolesTable.network_id))
		return results
	}

	static async listUserRolesWithNetworkId(user_id: number, network_id: number) {
		const results = await db
			.select({ user_role: userRolesTable, role: rolesTable })
			.from(userRolesTable)
			.where(
				and(
					eq(userRolesTable.user_id, user_id),
					eq(userRolesTable.status, true),
					eq(userRolesTable.network_id, network_id)
				)
			)
			.leftJoin(rolesTable, eq(userRolesTable.role_id, rolesTable.id))
		return results
	}

	static async listAllRoles() {
		const results = await db.select().from(rolesTable)
		return results
	}

	static async addPermissionToRole(args: {
		role_id: number
		permission_id: number
		executor_id: number
	}): ProperPromise<typeof rolePermissionsTable.$inferInsert> {
		const base_roles_write = SYNCED_CONFIG.permissions.find((e) => e.key === "base.roles.write")
		if (args.role_id === base_roles_write?.id) return [false, "can't add recursive roles due to security policy."]
		const [result] = await db
			.insert(rolePermissionsTable)
			.values({ created_by: args.executor_id, permission_id: args.permission_id, role_id: args.role_id })
			.onConflictDoUpdate({
				target: [rolePermissionsTable.role_id, rolePermissionsTable.permission_id],
				set: { updated_at: new Date(), updated_by: args.executor_id },
			})
			.returning()
		return [result]
	}

	static async removePermissionFromRole(args: { role_id: number; permission_id: number; executor_id: number }) : ProperPromise<typeof rolePermissionsTable.$inferSelect> {
		const base_roles_write = SYNCED_CONFIG.permissions.find((e) => e.key === "base.roles.write")
		if (args.role_id === base_roles_write?.id) return [false, "can't add recursive roles due to security policy."]
		let result
		try {
			[result] = await db
				.delete(rolePermissionsTable)
				.where(
					and(
						eq(rolePermissionsTable.role_id, args.role_id),
						eq(rolePermissionsTable.permission_id, args.permission_id)
					)
				)
				.returning()

		} catch (e) {
			logger.error(e as any)
			return [false,"İşlemi gerçekleştirirken database hata verdi."]
		}
		return [result]
	}
}
