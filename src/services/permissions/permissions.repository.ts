import { db } from "@db"
import { logger } from "@gezcez/core"
import { permissionsTable } from "@schemas"

export abstract class PermissionsRepository {
	static async createPermission(app: string, key: string) {
		await db
			.insert(permissionsTable)
			.values({
				app: app,
				key: key
			})
			.then((e) => {
				logger.success(
					`Created permission '${app}/${key}'`
				)
			})
		return true
	}
}
