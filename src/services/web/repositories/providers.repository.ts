import { providersTable } from "@schemas";
import { db } from "../../../db";

export abstract class ProvidersRepository {
	static async listAll() {
		return await db
			.select({
				id: providersTable.id,
				url: providersTable.url,
				name: providersTable.name,
				image_url: providersTable.image_url,
			})
			.from(providersTable)
	}
}