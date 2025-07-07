import { db } from "../../db"
import { eq } from "drizzle-orm"
import { emailsTable } from "@shared"

export abstract class EmailRepository {
	static async selectEmailById(uuid: string) {
		const [result] = await db
			.select()
			.from(emailsTable)
			.where(eq(emailsTable.uuid, uuid))
		if (!result) return [undefined,"email not found"]
		return [result]
	}
}
