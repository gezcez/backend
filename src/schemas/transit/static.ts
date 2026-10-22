// static.ts
// GTFS-shaped static tables. Every row carries version_id; integer ids never leave the backend
// (public ids are `<binding_id>.<external_id>`, plan 7.0).

import { index, int, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const agenciesTable = sqliteTable(
	"agencies",
	{
		id: int().primaryKey({ autoIncrement: true }),
		version_id: int().notNull(),
		binding_id: int().notNull(),
		external_id: text().notNull(),
		name: text().notNull(),
		color: text(),
		url: text(),
		phone: text(),
	},
	(t) => [
		uniqueIndex("agencies_version_ext_unique").on(t.version_id, t.binding_id, t.external_id),
	],
)

export const routesTable = sqliteTable(
	"routes",
	{
		id: int().primaryKey({ autoIncrement: true }),
		version_id: int().notNull(),
		binding_id: int().notNull(),
		/** Kentkart routeCode; matches the first segment of GTFS-RT routeId. */
		external_id: text().notNull(),
		/** displayRouteCode, e.g. 41C. */
		short_name: text().notNull(),
		long_name: text().notNull(),
		/** GTFS: 0 tram, 3 bus, 4 ferry. */
		route_type: int().notNull().default(3),
		color: text(),
		text_color: text(),
		agency_id: int(),
		is_public: int({ mode: "boolean" }).notNull().default(true),
		sort: int().notNull().default(0),
	},
	(t) => [
		uniqueIndex("routes_version_ext_unique").on(t.version_id, t.binding_id, t.external_id),
		index("routes_version_short_idx").on(t.version_id, t.binding_id, t.short_name),
	],
)

export const patternsTable = sqliteTable(
	"patterns",
	{
		id: int().primaryKey({ autoIncrement: true }),
		version_id: int().notNull(),
		route_id: int().notNull(),
		direction: int().notNull(),
		headsign: text().notNull(),
		/** Upstream pattern reference (pathInfo path_code). */
		external_ref: text().notNull(),
		/** Encoded polyline, precision 6. */
		shape: text().notNull(),
		length_m: int().notNull().default(0),
		stop_count: int().notNull().default(0),
	},
	(t) => [index("patterns_version_route_idx").on(t.version_id, t.route_id, t.direction)],
)

export const stopsTable = sqliteTable(
	"stops",
	{
		id: int().primaryKey({ autoIncrement: true }),
		version_id: int().notNull(),
		binding_id: int().notNull(),
		external_id: text().notNull(),
		name: text().notNull(),
		code: text(),
		lat_e6: int().notNull(),
		lon_e6: int().notNull(),
		/** 0.005 degree grid cell for nearby lookups (geo.utils gridCell). */
		cell: int().notNull(),
		wheelchair: int(),
		parent_id: int(),
	},
	(t) => [
		uniqueIndex("stops_version_ext_unique").on(t.version_id, t.binding_id, t.external_id),
		index("stops_version_cell_idx").on(t.version_id, t.cell),
	],
)

export const patternStopsTable = sqliteTable(
	"pattern_stops",
	{
		version_id: int().notNull(),
		pattern_id: int().notNull(),
		seq: int().notNull(),
		stop_id: int().notNull(),
		offset_s: int(),
		dist_m: int(),
	},
	(t) => [
		primaryKey({ columns: [t.version_id, t.pattern_id, t.seq] }),
		index("pattern_stops_version_stop_idx").on(t.version_id, t.stop_id),
	],
)

export const servicesTable = sqliteTable(
	"services",
	{
		id: int().primaryKey({ autoIncrement: true }),
		version_id: int().notNull(),
		binding_id: int().notNull(),
		external_id: text().notNull(),
		/** Mon=1, Tue=2 ... Sun=64. */
		days_mask: int().notNull(),
		label: text(),
		start_date: text(),
		end_date: text(),
	},
	(t) => [
		uniqueIndex("services_version_ext_unique").on(t.version_id, t.binding_id, t.external_id),
	],
)

export const tripsTable = sqliteTable(
	"trips",
	{
		id: int().primaryKey({ autoIncrement: true }),
		version_id: int().notNull(),
		pattern_id: int().notNull(),
		service_id: int().notNull(),
		/** Matches GTFS-RT tripId. */
		external_id: text().notNull(),
		/** Seconds after local midnight; may exceed 86400. */
		start_time_s: int().notNull(),
		headsign: text(),
		color: text(),
	},
	(t) => [
		index("trips_version_pattern_idx").on(
			t.version_id,
			t.pattern_id,
			t.service_id,
			t.start_time_s,
		),
		index("trips_version_ext_idx").on(t.version_id, t.external_id),
	],
)

export type RouteRow = typeof routesTable.$inferSelect
export type PatternRow = typeof patternsTable.$inferSelect
export type StopRow = typeof stopsTable.$inferSelect
export type TripRow = typeof tripsTable.$inferSelect
export type ServiceRow = typeof servicesTable.$inferSelect
export type AgencyRow = typeof agenciesTable.$inferSelect
