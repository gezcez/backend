import { eq } from "drizzle-orm";
import { networksTable } from "../../schema/networks";
import { db } from "../../util";
import { usersTable } from "../../schema/users";

export abstract class NetworkRepository {
	static async getNetworkById(id: number) {
		const [result] = await db.select(

		).from(networksTable).where(eq(networksTable.id, id))
			.limit(1)
		return result
	}

	static async list() {
		const result = await db.select().from(networksTable).limit(300)
		return result
	}
}