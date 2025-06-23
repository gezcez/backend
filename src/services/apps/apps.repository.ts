import { eq } from "drizzle-orm"
import { appsTable } from "../../schema/apps"
import { db } from "../../util"

export class AppsRepository {
	static async list() {
		const result = await db.select().from(appsTable).limit(50)
		return result
	}

	static async getAppByKey(key: string) {
		const [result] = await db.select().from(appsTable).where(eq(appsTable.key, key)).limit(1)
		return result
	}
}
