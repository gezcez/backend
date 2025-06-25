import { eq } from "drizzle-orm"
import { db } from "../../util"
import { emailsTable } from "../../schema/emails"

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
