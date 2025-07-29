import { and, eq, isNotNull, not } from "drizzle-orm"
import { db } from "../../db"
import { networksTable, providersTable } from "@schemas"

export abstract class NetworkRepository {
	static async getNetworkById(id: number | string) {
		if (typeof id === "string") id = parseInt(id)
		const [result] = await db
			.select()
			.from(networksTable)
			.where(eq(networksTable.id, id))
			.limit(1)
		return result
	}
	static async getNetworkWithProvider(net: number) {
		const [network] = await db
			.select({
				network: {
					id: networksTable.id,
					name: networksTable.name,
					country: networksTable.country,
					provider_id: networksTable.provider_id,
				},
				provider: {
					id: providersTable.id,
					name: providersTable.name,
					url: providersTable.url,
					image_url: providersTable.image_url,
					pulled_data: providersTable.pulled_data,
				},
			})
			.from(networksTable)
			.where(
				and(
					not(eq(networksTable.hide, true)),
					isNotNull(networksTable.provider_id),
					eq(networksTable.id, net)
				)
			)
			.leftJoin(providersTable, eq(providersTable.id, networksTable.id))
			.limit(1)
		return network
	}
	static async listWithProviders() {
		const networks = await db
			.select({
				network: {
					id: networksTable.id,
					name: networksTable.name,
					country: networksTable.country,
					provider_id: networksTable.provider_id,
					network_id_defined_by_provider: networksTable.network_id_defined_by_provider,
					public_secret: networksTable.network_public_secret,
				},
				provider: {
					id: providersTable.id,
					name: providersTable.name,
					url: providersTable.url,
					image_url: providersTable.image_url,
				},
			})
			.from(networksTable)
			.where(
				and(not(eq(networksTable.hide, true)), isNotNull(networksTable.provider_id))
			)
			.leftJoin(providersTable, eq(providersTable.id, networksTable.provider_id))
		return networks
	}
	static async list() {
		const result = await db.select().from(networksTable).limit(300)
		return result
	}
}
