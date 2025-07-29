
import { eq } from "drizzle-orm"
import { appsTable } from "@schemas"
import { db } from "../../../db"
export class AppsRepository {
	static async list() {
		const result = await db.select().from(appsTable).limit(50)
		return result
	}

	static async getAppByKey(key: string) {
		const [result] = await db
			.select()
			.from(appsTable)
			.where(eq(appsTable.key, key))
			.limit(1)
		return result
	}
}
