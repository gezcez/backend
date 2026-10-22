// networks.repository.ts
// core.db catalog reads: cities, networks, providers and provider bindings.

import { Injectable } from "@nestjs/common"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import {
	citiesTable,
	networksTable,
	providerBindingsTable,
	providersTable,
	type CatalogStatus,
	type CityRow,
	type NetworkRow,
	type ProviderBindingRow,
	type ProviderRow,
} from "@schemas/core"

export interface BindingWithContext {
	binding: ProviderBindingRow
	network: NetworkRow
	city: CityRow
	provider: ProviderRow
}

@Injectable()
export class NetworksRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	listCities(statuses?: CatalogStatus[]): CityRow[] {
		const query = this.db.select().from(citiesTable)
		return (statuses ? query.where(inArray(citiesTable.status, statuses)) : query)
			.orderBy(asc(citiesTable.sort), asc(citiesTable.slug))
			.all()
	}

	findCity(ref: string): CityRow | undefined {
		const id = /^\d+$/.test(ref) ? Number(ref) : undefined
		return this.db
			.select()
			.from(citiesTable)
			.where(id !== undefined ? eq(citiesTable.id, id) : eq(citiesTable.slug, ref))
			.get()
	}

	cityById(id: number): CityRow | undefined {
		return this.db.select().from(citiesTable).where(eq(citiesTable.id, id)).get()
	}

	listNetworks(filter: { cityId?: number; statuses?: CatalogStatus[] } = {}): NetworkRow[] {
		const conditions = [isNull(networksTable.deleted_at)]
		if (filter.cityId !== undefined) conditions.push(eq(networksTable.city_id, filter.cityId))
		if (filter.statuses) conditions.push(inArray(networksTable.status, filter.statuses))
		return this.db
			.select()
			.from(networksTable)
			.where(and(...conditions))
			.orderBy(asc(networksTable.name))
			.all()
	}

	findNetwork(ref: string): NetworkRow | undefined {
		const id = /^\d+$/.test(ref) ? Number(ref) : undefined
		return this.db
			.select()
			.from(networksTable)
			.where(
				and(
					id !== undefined ? eq(networksTable.id, id) : eq(networksTable.slug, ref),
					isNull(networksTable.deleted_at),
				),
			)
			.get()
	}

	listProviders(): ProviderRow[] {
		return this.db
			.select()
			.from(providersTable)
			.where(isNull(providersTable.deleted_at))
			.orderBy(asc(providersTable.key))
			.all()
	}

	findProvider(key: string): ProviderRow | undefined {
		return this.db.select().from(providersTable).where(eq(providersTable.key, key)).get()
	}

	listBindings(networkId?: number): ProviderBindingRow[] {
		const conditions = [isNull(providerBindingsTable.deleted_at)]
		if (networkId !== undefined)
			conditions.push(eq(providerBindingsTable.network_id, networkId))
		return this.db
			.select()
			.from(providerBindingsTable)
			.where(and(...conditions))
			.orderBy(asc(providerBindingsTable.id))
			.all()
	}

	findBinding(id: number): ProviderBindingRow | undefined {
		return this.db
			.select()
			.from(providerBindingsTable)
			.where(and(eq(providerBindingsTable.id, id), isNull(providerBindingsTable.deleted_at)))
			.get()
	}

	/** Every non-deleted binding with its network, city and provider rows. */
	bindingsWithContext(): BindingWithContext[] {
		return this.db
			.select({
				binding: providerBindingsTable,
				network: networksTable,
				city: citiesTable,
				provider: providersTable,
			})
			.from(providerBindingsTable)
			.innerJoin(networksTable, eq(networksTable.id, providerBindingsTable.network_id))
			.innerJoin(citiesTable, eq(citiesTable.id, networksTable.city_id))
			.innerJoin(providersTable, eq(providersTable.key, providerBindingsTable.provider_key))
			.where(and(isNull(providerBindingsTable.deleted_at), isNull(networksTable.deleted_at)))
			.orderBy(asc(providerBindingsTable.id))
			.all()
	}
}
