// transit.models.ts
// Domain shapes shared by DTO files (plan 4: src/common/models). Clients get them through
// openapi.json, never as an import. JSON on the wire is snake_case; times in REST are ISO strings.

import { z } from "zod"

export const LonLatSchema = z.tuple([z.number(), z.number()]).describe("[lon, lat]")
export const BBoxSchema = z
	.tuple([z.number(), z.number(), z.number(), z.number()])
	.describe("[west, south, east, north]")

export const I18nTextSchema = z
	.object({ tr: z.string().describe("Turkish"), en: z.string().describe("English") })
	.describe("Text in both supported languages")

export const MODES = {
	0: "tram",
	1: "metro",
	2: "rail",
	3: "bus",
	4: "ferry",
	5: "cable_tram",
	6: "aerial_lift",
	7: "funicular",
	11: "trolleybus",
	12: "monorail",
} as const satisfies Record<number, string>

export type Mode = (typeof MODES)[keyof typeof MODES]
export const ModeSchema = z
	.enum(Object.values(MODES) as [Mode, ...Mode[]])
	.describe("Transport mode, from the GTFS route_type")

export function modeOf(routeType: number): Mode {
	return (MODES as Record<number, Mode>)[routeType] ?? "bus"
}

export const MODE_LABELS: Record<Mode, { tr: string; en: string }> = {
	tram: { tr: "Tramvay", en: "Tram" },
	metro: { tr: "Metro", en: "Metro" },
	rail: { tr: "Tren", en: "Rail" },
	bus: { tr: "Otobüs", en: "Bus" },
	ferry: { tr: "Vapur", en: "Ferry" },
	cable_tram: { tr: "Kablolu tramvay", en: "Cable tram" },
	aerial_lift: { tr: "Teleferik", en: "Aerial lift" },
	funicular: { tr: "Füniküler", en: "Funicular" },
	trolleybus: { tr: "Troleybüs", en: "Trolleybus" },
	monorail: { tr: "Monoray", en: "Monorail" },
}

export const CardCapabilitySchema = z.object({
	balance: z.boolean().describe("POST /cards/lookup works"),
	history: z.boolean().describe("POST /cards/history works"),
	requires_provider_account: z
		.boolean()
		.describe("True when the provider needs a linked account (not supported yet)"),
	number_format: z.string().nullable().describe("Regular expression of a valid card number"),
	label: I18nTextSchema.describe("The card's local name"),
})

export const CapabilitiesSchema = z
	.object({
		stops: z.boolean().describe("Stops are available"),
		routes: z.boolean().describe("Routes are available"),
		timetables: z.boolean().describe("GET /routes/{routeId}/timetable has data"),
		shapes: z.boolean().describe("GET /routes/{routeId}/shape has data"),
		realtime_vehicles: z.boolean().describe("Live vehicle positions (REST and WebSocket)"),
		realtime_departures: z
			.enum(["none", "estimated", "live"])
			.describe(
				"none: schedule only; estimated: schedule plus live vehicles; live: provider predictions",
			),
		trip_updates: z.boolean().describe("The provider publishes GTFS-RT trip updates"),
		alerts: z.boolean().describe("GET /networks/{networkId}/alerts has data"),
		card: CardCapabilitySchema.nullable().describe("Card features, null when unsupported"),
		trip_planner: z.literal(false).describe("Reserved"),
		bike_share: z.literal(false).describe("Reserved"),
	})
	.describe("What this network supports; hide features whose flag is false")

export const NetworkStatusSchema = z
	.enum(["active", "degraded", "disabled"])
	.describe("degraded: live data is partial or late; disabled: live data is off")

export const NetworkSummarySchema = z.object({
	id: z.number().int().describe("Numeric network id; the slug works wherever an id does"),
	slug: z.string().describe("URL-safe network id"),
	name: z.string().describe("Display name"),
	operator_name: z.string().nullable().describe("Operating company"),
	colour: z.string().nullable().describe("Brand colour, #rrggbb"),
	status: NetworkStatusSchema,
	status_message: z.string().nullable().describe("Why the status is not active"),
	modes: z.array(ModeSchema).describe("Modes the network runs"),
})

export const RouteSummarySchema = z.object({
	id: z.string().describe("Stable public id, e.g. 1.42041"),
	network_id: z.number().int().describe("Network the route belongs to"),
	short_name: z.string().describe("Line number or code shown on the vehicle"),
	long_name: z.string().describe("Line name, usually its terminals"),
	mode: ModeSchema,
	route_type: z.number().int().describe("GTFS route_type"),
	colour: z.string().nullable().describe("Line colour, #rrggbb"),
	text_colour: z.string().nullable().describe("Text colour on the line colour, #rrggbb"),
	agency: z.string().nullable().describe("Operating agency"),
})

export const StopSummarySchema = z.object({
	id: z.string().describe("Stable public id, e.g. 1.41003"),
	network_id: z.number().int().describe("Network the stop belongs to"),
	name: z.string().describe("Stop name"),
	code: z.string().nullable().describe("Code printed at the stop, when the network has one"),
	lat: z.number().describe("Latitude (WGS 84)"),
	lon: z.number().describe("Longitude (WGS 84)"),
})

/** Compact vehicle row order of the WS protocol (plan 6.10). */
export const VEHICLE_FIELDS_COMPACT = [
	"id",
	"lat",
	"lon",
	"bearing",
	"speed_ms",
	"route_id",
	"direction",
	"trip_id",
	"stop_seq",
	"status",
	"vehicle_ts",
	"flags",
] as const
export const VEHICLE_FIELDS_FULL = [
	...VEHICLE_FIELDS_COMPACT,
	"plate",
	"stop_id",
	"headsign",
] as const

/** flags bits of a vehicle row. */
export const VEHICLE_FLAGS = { stale: 1, accessible: 2, at_terminus: 4 } as const

export const VehicleRowSchema = z
	.array(z.union([z.string(), z.number(), z.null()]))
	.describe("Values in the order given by `fields`")

export const DepartureSchema = z.object({
	route: RouteSummarySchema,
	headsign: z.string().nullable().describe("Destination shown on the vehicle"),
	direction: z.union([z.literal(0), z.literal(1)]).describe("Direction of the trip's pattern"),
	trip_id: z.string().nullable().describe("Scheduled trip, when matched"),
	scheduled_at: z.string().nullable().describe("Timetabled departure (ISO 8601)"),
	predicted_at: z
		.string()
		.nullable()
		.describe("Expected departure from a live vehicle (ISO 8601); null without one"),
	vehicle_id: z.string().nullable().describe("Stable public id of the live vehicle"),
	stops_away: z.number().int().nullable().describe("Stops between the vehicle and this stop"),
	source: z
		.enum(["schedule", "live", "live_eta"])
		.describe(
			"schedule: timetable only; live: a vehicle is on the way; live_eta: predicted from live travel times",
		),
	cancelled: z.boolean().describe("The provider cancelled this trip"),
})
