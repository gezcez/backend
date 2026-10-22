// seed-catalog.ts
// Catalog seed (plan 5.1): providers, the Kocaeli city, its network and the provider binding for
// Kentkart region 004. Rows are created when missing and never overwritten, so dashboard edits
// survive a re-seed. Tests bind the same network to the fake provider instead of Kentkart.

import { and, eq } from "drizzle-orm"
import type { CoreDatabase } from "./database.module"
import type { SeedStep } from "./seed"
import {
	citiesTable,
	networksTable,
	providerBindingsTable,
	providersTable,
	type PulledDataItem,
} from "@schemas/core"

const KENTKART_PULLED: PulledDataItem[] = [
	{
		key: "vehicle_positions",
		is_collected: true,
		can_optout: false,
		details: "Public vehicle positions (GTFS-Realtime) per region",
	},
	{
		key: "timetables",
		is_collected: true,
		can_optout: false,
		details: "Routes, stops, shapes and timetables",
	},
	{
		key: "personal_data",
		is_collected: false,
		can_optout: false,
		details: "No rider or card data is collected",
	},
]

export const KOCAELI = {
	city: {
		slug: "kocaeli",
		name: { tr: "Kocaeli", en: "Kocaeli" },
		country_code: "TR",
		timezone: "Europe/Istanbul",
		center_lat_e6: 40_765_400,
		center_lon_e6: 29_940_800,
		bbox: [29.25, 40.5, 30.4, 41.2] as [number, number, number, number],
	},
	network: {
		slug: "kocaeli-ulasimpark",
		name: "UlaşımPark",
		operator_name: "UlaşımPark A.Ş.",
		color: "#0b4f8a",
	},
	kentkartRegion: "004",
	fakeRef: "kocaeli",
}

function ensureProvider(
	db: CoreDatabase,
	row: { key: string; name: string; url: string | null; pulled_data: PulledDataItem[] },
): boolean {
	const existing = db.select().from(providersTable).where(eq(providersTable.key, row.key)).get()
	if (existing) return false
	db.insert(providersTable)
		.values({ ...row, enabled: true, created_at: new Date() })
		.run()
	return true
}

export const catalogStep: SeedStep = {
	name: "catalog",
	run(db, { environment }) {
		const created: string[] = []
		if (
			ensureProvider(db, {
				key: "kentkart",
				name: "Kentkart",
				url: "https://www.kentkart.com",
				pulled_data: KENTKART_PULLED,
			})
		)
			created.push("provider kentkart")
		const withFake = environment === "local" || environment === "test"
		if (
			withFake &&
			ensureProvider(db, {
				key: "fake",
				name: "Fake provider",
				url: null,
				pulled_data: [],
			})
		)
			created.push("provider fake")

		let city = db
			.select()
			.from(citiesTable)
			.where(eq(citiesTable.slug, KOCAELI.city.slug))
			.get()
		if (!city) {
			city = db
				.insert(citiesTable)
				.values({ ...KOCAELI.city, status: "public" })
				.returning()
				.get()
			created.push("city kocaeli")
		}
		let network = db
			.select()
			.from(networksTable)
			.where(eq(networksTable.slug, KOCAELI.network.slug))
			.get()
		if (!network) {
			network = db
				.insert(networksTable)
				.values({
					...KOCAELI.network,
					city_id: city.id,
					status: "public",
					created_at: new Date(),
				})
				.returning()
				.get()
			created.push(`network ${KOCAELI.network.slug}`)
		}
		const binding =
			environment === "test"
				? { provider_key: "fake", external_ref: KOCAELI.fakeRef }
				: { provider_key: "kentkart", external_ref: KOCAELI.kentkartRegion }
		const existing = db
			.select()
			.from(providerBindingsTable)
			.where(
				and(
					eq(providerBindingsTable.provider_key, binding.provider_key),
					eq(providerBindingsTable.external_ref, binding.external_ref),
				),
			)
			.get()
		if (!existing) {
			db.insert(providerBindingsTable)
				.values({
					...binding,
					network_id: network.id,
					status: "active",
					created_at: new Date(),
				})
				.run()
			created.push(`binding ${binding.provider_key}:${binding.external_ref}`)
		}
		return created.length ? created.join(", ") : "unchanged"
	},
}
