// catalog.ts
// Cities, networks, providers and provider bindings (plan sections 5.1 and 6.5). Roles and audit
// rows are network scoped, so the catalog lives in core.db with real foreign keys.

import { index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { auditColumns } from "../_audit"

export type CatalogStatus = "draft" | "public" | "hidden"
export type I18nText = { tr: string; en: string }

export const citiesTable = sqliteTable(
	"cities",
	{
		id: int().primaryKey({ autoIncrement: true }),
		slug: text().notNull(),
		name: text({ mode: "json" }).$type<I18nText>().notNull(),
		country_code: text().notNull().default("TR"),
		timezone: text().notNull().default("Europe/Istanbul"),
		center_lat_e6: int(),
		center_lon_e6: int(),
		bbox: text({ mode: "json" }).$type<[number, number, number, number]>(),
		status: text().$type<CatalogStatus>().notNull().default("draft"),
		sort: int().notNull().default(0),
	},
	(t) => [uniqueIndex("cities_slug_unique").on(t.slug)],
)

export const networksTable = sqliteTable(
	"networks",
	{
		id: int().primaryKey({ autoIncrement: true }),
		city_id: int()
			.notNull()
			.references(() => citiesTable.id),
		slug: text().notNull(),
		name: text().notNull(),
		operator_name: text(),
		color: text(),
		status: text().$type<CatalogStatus>().notNull().default("draft"),
		...auditColumns(),
	},
	(t) => [
		uniqueIndex("networks_slug_unique").on(t.slug),
		index("networks_city_idx").on(t.city_id),
	],
)

export type CityRow = typeof citiesTable.$inferSelect
export type NetworkRow = typeof networksTable.$inferSelect

/** What a provider declares it collects, shown on the public privacy page. */
export interface PulledDataItem {
	key: string
	is_collected: boolean
	can_optout: boolean
	details: string
}

export const providersTable = sqliteTable("providers", {
	key: text().primaryKey(),
	name: text().notNull(),
	url: text(),
	image_url: text(),
	/** Global kill switch (dashboard level). The env hard kill sits above it. */
	enabled: int({ mode: "boolean" }).notNull().default(true),
	disabled_reason: text(),
	pulled_data: text({ mode: "json" }).$type<PulledDataItem[]>().notNull().default([]),
	legal_note: text(),
	...auditColumns(),
})

export type BindingStatus = "active" | "paused" | "disabled"

export const providerBindingsTable = sqliteTable(
	"provider_bindings",
	{
		/** The "region id" used everywhere in vts.db, transit.db and the archive. */
		id: int().primaryKey({ autoIncrement: true }),
		network_id: int()
			.notNull()
			.references(() => networksTable.id),
		provider_key: text()
			.notNull()
			.references(() => providersTable.key),
		/** Upstream reference, for Kentkart the 3-digit region ("004"). */
		external_ref: text().notNull(),
		/** Non-secret adapter config (base URL variants, filter rules); validated by the adapter. */
		config: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
		/** Capability overrides on top of the provider declaration. */
		capabilities: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
		poll_interval_s: int().notNull().default(30),
		idle_poll_interval_s: int().notNull().default(60),
		status: text().$type<BindingStatus>().notNull().default("active"),
		disabled_reason: text(),
		...auditColumns(),
	},
	(t) => [
		uniqueIndex("provider_bindings_provider_ref_unique").on(t.provider_key, t.external_ref),
		index("provider_bindings_network_idx").on(t.network_id),
	],
)

export type ProviderRow = typeof providersTable.$inferSelect
export type ProviderBindingRow = typeof providerBindingsTable.$inferSelect
