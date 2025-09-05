import { db } from "@db"
import { logger } from "@gezcez/core"
import { config } from "@index"
import { permissionsTable } from "@schemas"

export abstract class PermissionsRepository {
	static async createPermission(app: string, key: string) {
		await db
			.insert(permissionsTable)
			.values({
				app: config.app_key,
				key: config.permission_key
			})
			.then((e) => {
				logger.success(
					`Created permission '${config.app_key}/${config.permission_key}'`
				)
			})
		return true
	}
}
