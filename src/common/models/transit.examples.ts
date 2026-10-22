// transit.examples.ts
// Example values for the OpenAPI document, taken from Kocaeli (UlaşımPark, Kentkart region 004,
// binding 1). Documentation only: each constant is typed against its schema so the examples
// cannot drift from the contract, and transit.examples.spec.ts parses them at runtime too.

import type { z } from "zod"
import type {
	CapabilitiesSchema,
	DepartureSchema,
	NetworkSummarySchema,
	RouteSummarySchema,
	StopSummarySchema,
} from "./transit.models"

type Out<T extends z.ZodType> = z.output<T>

export const EXAMPLE_CITY_BASE = {
	id: 1,
	slug: "kocaeli",
	name: { tr: "Kocaeli", en: "Kocaeli" },
	country_code: "TR",
	timezone: "Europe/Istanbul",
	centre: [29.9408, 40.7654] as [number, number],
	bbox: [29.25, 40.5, 30.4, 41.2] as [number, number, number, number],
}

export const EXAMPLE_NETWORK = {
	id: 1,
	slug: "kocaeli-ulasimpark",
	name: "UlaşımPark",
	operator_name: "UlaşımPark A.Ş.",
	colour: "#0b4f8a",
	status: "active",
	status_message: null,
	modes: ["tram", "bus"],
} satisfies Out<typeof NetworkSummarySchema>

export const EXAMPLE_CAPABILITIES = {
	stops: true,
	routes: true,
	timetables: true,
	shapes: true,
	realtime_vehicles: true,
	realtime_departures: "estimated",
	trip_updates: false,
	alerts: false,
	card: {
		balance: true,
		history: true,
		requires_provider_account: false,
		number_format: "^[0-9]{10,16}$",
		label: { tr: "Kentkart", en: "Kentkart" },
	},
	trip_planner: false,
	bike_share: false,
} satisfies Out<typeof CapabilitiesSchema>

/** Akçaray tram: Sahil Otopark to Sekapark. */
export const EXAMPLE_ROUTE_TRAM = {
	id: "1.42041",
	network_id: 1,
	short_name: "T1",
	long_name: "Sahil Otopark - Cumhuriyet Parkı - Sekapark",
	mode: "tram",
	route_type: 0,
	colour: "#d71920",
	text_colour: "#ffffff",
	agency: "UlaşımPark A.Ş.",
} satisfies Out<typeof RouteSummarySchema>

/** Bus 24: Vinsan to Umuttepe (Kocaeli University). */
export const EXAMPLE_ROUTE_BUS = {
	id: "1.41024",
	network_id: 1,
	short_name: "24",
	long_name: "Vinsan - Umuttepe",
	mode: "bus",
	route_type: 3,
	colour: "#0b4f8a",
	text_colour: "#ffffff",
	agency: "UlaşımPark A.Ş.",
} satisfies Out<typeof RouteSummarySchema>

export const EXAMPLE_STOP = {
	id: "1.41003",
	network_id: 1,
	name: "Cumhuriyet Parkı",
	code: "41003",
	lat: 40.76562,
	lon: 29.92561,
} satisfies Out<typeof StopSummarySchema>

export const EXAMPLE_STOP_SEKAPARK = {
	id: "1.41011",
	network_id: 1,
	name: "Sekapark",
	code: "41011",
	lat: 40.76183,
	lon: 29.93612,
} satisfies Out<typeof StopSummarySchema>

export const EXAMPLE_STOP_UMUTTEPE = {
	id: "1.40562",
	network_id: 1,
	name: "Umuttepe Kampüsü",
	code: "40562",
	lat: 40.82371,
	lon: 29.92284,
} satisfies Out<typeof StopSummarySchema>

export const EXAMPLE_DEPARTURE_LIVE = {
	route: EXAMPLE_ROUTE_TRAM,
	headsign: "Sekapark",
	direction: 0,
	trip_id: "1.42041-0-0745",
	scheduled_at: "2026-10-22T07:51:00.000Z",
	predicted_at: "2026-10-22T07:52:30.000Z",
	vehicle_id: "1.4170",
	stops_away: 2,
	source: "live",
	cancelled: false,
} satisfies Out<typeof DepartureSchema>

export const EXAMPLE_DEPARTURE_SCHEDULED = {
	route: EXAMPLE_ROUTE_BUS,
	headsign: "Umuttepe",
	direction: 1,
	trip_id: "1.41024-1-0800",
	scheduled_at: "2026-10-22T08:04:00.000Z",
	predicted_at: null,
	vehicle_id: null,
	stops_away: null,
	source: "schedule",
	cancelled: false,
} satisfies Out<typeof DepartureSchema>

/** A compact vehicle row in VEHICLE_FIELDS_COMPACT order. */
export const EXAMPLE_VEHICLE_ROW: (string | number | null)[] = [
	"1.4170",
	40.76418,
	29.93087,
	92,
	6.4,
	"1.42041",
	0,
	"1.42041-0-0745",
	7,
	2,
	1792656300,
	2,
]
