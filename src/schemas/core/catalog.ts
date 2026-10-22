// catalog.ts
// Cities and networks. Roles and audit rows are network scoped, so they live in core.db.
// Providers and bindings join in P2/P3.

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
