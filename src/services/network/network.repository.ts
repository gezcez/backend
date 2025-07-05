import { eq } from "drizzle-orm";
import { db } from "../../db";
import { networksTable } from "../../schemas";

export abstract class NetworkRepository {
	static async getNetworkById(id: number|string) {
		if (typeof id === "string") id = parseInt(id)
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