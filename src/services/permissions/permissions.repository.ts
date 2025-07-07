import { permissionsTable, userPermissionsTable } from "@shared"
import { db } from "../../db"
import { and, eq } from "drizzle-orm"


export abstract class PermissionsRepository {
	static async insert(values:typeof permissionsTable.$inferInsert) {
		const [result] = await db.insert(permissionsTable).values(values).returning()
		return result
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
}