import { networksTable, rolesTable, userRolesTable } from "@shared"
import { db } from "../../db"
import { and, eq } from "drizzle-orm"

export abstract class RolesRepository {
	static async listUserNetworks(
		user_id: number
	) {
		const results = await db
			.select({
				network: {
					id:networksTable.id,
					name:networksTable.name
				}
			})
			.from(userRolesTable)
			.where(
				and(
					eq(userRolesTable.status, true),
					eq(userRolesTable.user_id, user_id)
				)
			).groupBy(userRolesTable.network_id).leftJoin(networksTable,eq(networksTable.id,userRolesTable.network_id))
		return results
	}

	static async listUserRolesWithNetworkId(user_id:number,network_id:number) {
		const results = await db.select({user_role:userRolesTable,role:rolesTable}).from(userRolesTable).where(and(
			eq(userRolesTable.user_id,user_id),
			eq(userRolesTable.status,true),
			eq(userRolesTable.network_id,network_id)
		)).leftJoin(rolesTable,eq(userRolesTable.role_id,rolesTable.id))
		return results
	}

	static async listAllRoles() {
		const results = await db.select().from(rolesTable)
		return results
	}
}