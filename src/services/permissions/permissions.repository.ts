import { db } from "../../db"
import { permissionsTable } from "../../schemas"


export abstract class PermissionsRepository {
	static async insert(values:typeof permissionsTable.$inferInsert) {
		const [result] = await db.insert(permissionsTable).values(values).returning()
		return result
	}

	static async list() {
		const result = await db.select().from(permissionsTable)
		return result
	}
	static async delete() {
		
	}
}