import { db } from "../../db"
import { eq } from "drizzle-orm"
import { emailsTable, sesLogsTable } from "@schemas"

export abstract class EmailRepository {
	static async selectEmailById(uuid: string) {
		const [result] = await db
			.select()
			.from(emailsTable)
			.where(eq(emailsTable.uuid, uuid))
		if (!result) return [undefined,"email not found"]
		return [result]
	}
	static async insertEmail(args: typeof emailsTable.$inferInsert) {
		const [result] = await db.insert(emailsTable).values(args).returning()
		return result
	}
	static async insertSesLog(args: typeof sesLogsTable.$inferInsert) {
		const [result] = await db.insert(sesLogsTable).values(args).returning()
		return result
	}
}
