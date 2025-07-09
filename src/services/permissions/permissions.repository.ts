import { networksTable, permissionsTable, userPermissionsTable } from "@shared"
import { db } from "../../db"
import { and, eq, inArray } from "drizzle-orm"


export abstract class PermissionsRepository {
	static async insert(values:typeof permissionsTable.$inferInsert) {
		const [result] = await db.insert(permissionsTable).values(values).returning()
		return result
	}
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
			.from(userPermissionsTable)
			.where(
				and(
					eq(userPermissionsTable.status, true),
					eq(userPermissionsTable.user_id, user_id)
				)
			).groupBy(userPermissionsTable.network_id).leftJoin(networksTable,eq(networksTable.id,userPermissionsTable.network_id))
		return results
	}
	static async listUserPermissionsWithNetworkId(
		user_id: number,
		network_id: number
	) {
		const results = await db
			.select()
			.from(userPermissionsTable)
			.where(
				and(
					eq(userPermissionsTable.status, true),
					eq(userPermissionsTable.user_id, user_id),
					eq(userPermissionsTable.network_id, network_id)
				)
			)
		return results
	}
	static async list() {
		const result = await db.select().from(permissionsTable)
		return result
	}
	static async delete() {
		
	}

	static async listPermissionsFromPermissionIds(ids:number[]) {
		const result = await db.select().from(permissionsTable).where(inArray(permissionsTable.id,ids))
		return result
	}
}