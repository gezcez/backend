// transit.models.ts
// Domain shapes shared by DTO files (plan 4: src/common/models). Clients get them through
// openapi.json, never as an import. JSON on the wire is snake_case; times in REST are ISO strings.

import { z } from "zod"

export const LonLatSchema = z.tuple([z.number(), z.number()]).describe("[lon, lat]")
export const BBoxSchema = z
	.tuple([z.number(), z.number(), z.number(), z.number()])
	.describe("[west, south, east, north]")

export const I18nTextSchema = z.object({ tr: z.string(), en: z.string() })

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
export const ModeSchema = z.enum(Object.values(MODES) as [Mode, ...Mode[]])

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
	balance: z.boolean(),
	history: z.boolean(),
	requires_provider_account: z.boolean(),
	number_format: z.string().nullable(),
	label: I18nTextSchema,
})

export const CapabilitiesSchema = z.object({
	stops: z.boolean(),
	routes: z.boolean(),
	timetables: z.boolean(),
	shapes: z.boolean(),
	realtime_vehicles: z.boolean(),
	realtime_departures: z.enum(["none", "estimated", "live"]),
	trip_updates: z.boolean(),
	alerts: z.boolean(),
	card: CardCapabilitySchema.nullable(),
	trip_planner: z.literal(false),
	bike_share: z.literal(false),
})

export const NetworkStatusSchema = z.enum(["active", "degraded", "disabled"])

export const NetworkSummarySchema = z.object({
	id: z.number().int(),
	slug: z.string(),
	name: z.string(),
	operator_name: z.string().nullable(),
	colour: z.string().nullable(),
	status: NetworkStatusSchema,
	status_message: z.string().nullable(),
	modes: z.array(ModeSchema),
})

export const RouteSummarySchema = z.object({
	id: z.string().describe("Stable public id, e.g. 1.42041"),
	network_id: z.number().int(),
	short_name: z.string(),
	long_name: z.string(),
	mode: ModeSchema,
	route_type: z.number().int(),
	colour: z.string().nullable(),
	text_colour: z.string().nullable(),
	agency: z.string().nullable(),
})

export const StopSummarySchema = z.object({
	id: z.string().describe("Stable public id, e.g. 1.41003"),
	network_id: z.number().int(),
	name: z.string(),
	code: z.string().nullable(),
	lat: z.number(),
	lon: z.number(),
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
	headsign: z.string().nullable(),
	trip_id: z.string().nullable(),
	scheduled_at: z.string().nullable(),
	predicted_at: z.string().nullable(),
	vehicle_id: z.string().nullable(),
	stops_away: z.number().int().nullable(),
	source: z.enum(["schedule", "live", "live_eta"]),
	cancelled: z.boolean(),
})
