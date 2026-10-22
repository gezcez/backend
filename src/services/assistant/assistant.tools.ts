// assistant.tools.ts
// The tools the assistant model may call. Each one wraps an existing transit service, validates
// its input with zod, returns a compact JSON result for the model and a full card for the app.
// Model-facing results carry no coordinates: nearby stops would otherwise reveal where the user
// is. The user's own location is never a tool input; nearby_stops reads it from the request.

import { Injectable } from "@nestjs/common"
import type Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"
import { GezcezError } from "@common/errors"
import { TransitService } from "@services/transit/transit.service"
import { VehiclesService } from "@services/vehicles/vehicles.service"
import type { AssistantCard, AssistantContext } from "./assistant.dto"

type Tool = Anthropic.Beta.BetaTool

export interface ToolOutcome {
	/** JSON text for the tool_result block. */
	content: string
	isError: boolean
	card?: AssistantCard
}

const id = z.string().trim().min(1).max(64)

const INPUTS = {
	search_transit: z.object({
		query: z.string().trim().min(1).max(100),
		network: z.string().max(64).optional(),
		city: z.string().max(64).optional(),
	}),
	stop_departures: z.object({
		stop_id: id,
		limit: z.number().int().min(1).max(20).optional(),
	}),
	stop_detail: z.object({ stop_id: id }),
	route_detail: z.object({ route_id: id }),
	nearby_stops: z.object({
		radius_m: z.number().int().min(100).max(1500).optional(),
		network: z.string().max(64).optional(),
	}),
} satisfies Record<string, z.ZodObject>

export type AssistantToolName = keyof typeof INPUTS

const DESCRIPTIONS: Record<AssistantToolName, string> = {
	search_transit:
		"Search routes and stops by name, number or code (Turkish letters folded). Use it to turn what the user typed into route_id or stop_id values before calling other tools.",
	stop_departures:
		"Next departures at one stop: scheduled times merged with live vehicles (source live or live_eta means a tracked vehicle). Times are ISO 8601 with offset.",
	stop_detail: "One stop and the routes that serve it.",
	route_detail:
		"One route with its directions, headsigns and the ordered stops of each direction's main pattern.",
	nearby_stops:
		"Stops near the user, nearest first, with walking distance in metres. Works only when the user shared their location with this message; otherwise it returns an error saying so.",
}

function inputSchema(schema: z.ZodObject): Tool["input_schema"] {
	const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
		target: "draft-2020-12",
		io: "input",
	}) as Record<string, unknown>
	return rest as Tool["input_schema"]
}

/** Tool definitions in a fixed order, so the request prefix stays cacheable. */
export const ASSISTANT_TOOLS: Tool[] = (Object.keys(INPUTS) as AssistantToolName[]).map(
	(name) => ({ name, description: DESCRIPTIONS[name], input_schema: inputSchema(INPUTS[name]) }),
)

function isToolName(name: string): name is AssistantToolName {
	return name in INPUTS
}

/** Drops coordinates from stop-like objects before the model sees them. */
function withoutCoords<T extends { lat?: number; lon?: number }>(stop: T): Omit<T, "lat" | "lon"> {
	const { lat: _lat, lon: _lon, ...rest } = stop
	return rest
}

@Injectable()
export class AssistantTools {
	constructor(
		private readonly transit: TransitService,
		private readonly vehicles: VehiclesService,
	) {}

	run(name: string, input: unknown, context: AssistantContext): ToolOutcome {
		if (!isToolName(name)) return this.error(`unknown tool ${name}`)
		const parsed = INPUTS[name].safeParse(input)
		if (!parsed.success)
			return this.error(`invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
		try {
			return this.dispatch(name, parsed.data as never, context)
		} catch (error) {
			if (error instanceof GezcezError && error.status < 500)
				return this.error(`${error.code}: ${error.message}`)
			throw error
		}
	}

	private dispatch(
		name: AssistantToolName,
		input: z.infer<(typeof INPUTS)[AssistantToolName]>,
		context: AssistantContext,
	): ToolOutcome {
		switch (name) {
			case "search_transit": {
				const i = input as z.infer<typeof INPUTS.search_transit>
				const network = i.network ?? (i.city ? undefined : context.network)
				const city = i.city ?? context.city
				const data = this.transit.search({ q: i.query, network, city, limit: 8 })
				return this.ok(
					{ routes: data.routes, stops: data.stops.map(withoutCoords) },
					{ kind: "search", data },
				)
			}
			case "stop_departures": {
				const i = input as z.infer<typeof INPUTS.stop_departures>
				const data = this.vehicles.departures(i.stop_id, i.limit ?? 8)
				return this.ok(
					{
						stop: withoutCoords(data.stop),
						generated_at: data.generated_at,
						items: data.items.map((d) => ({
							route_id: d.route.id,
							route: d.route.short_name,
							headsign: d.headsign,
							direction: d.direction,
							scheduled_at: d.scheduled_at,
							predicted_at: d.predicted_at,
							stops_away: d.stops_away,
							source: d.source,
							cancelled: d.cancelled,
						})),
					},
					{ kind: "departures", data },
				)
			}
			case "stop_detail": {
				const i = input as z.infer<typeof INPUTS.stop_detail>
				const data = this.transit.stopDetail(i.stop_id)
				return this.ok(withoutCoords(data), { kind: "stop", data })
			}
			case "route_detail": {
				const i = input as z.infer<typeof INPUTS.route_detail>
				const data = this.transit.routeDetail(i.route_id)
				const { directions, ...route } = data
				return this.ok(
					{
						...route,
						directions: directions.map((d) => {
							const main = d.patterns[0]
							return {
								direction: d.direction,
								headsign: d.headsign,
								patterns: d.patterns.length,
								stops: (main?.stops ?? []).map((s) => ({
									id: s.id,
									name: s.name,
									offset_s: s.offset_s,
								})),
							}
						}),
					},
					{ kind: "route", data },
				)
			}
			case "nearby_stops": {
				const i = input as z.infer<typeof INPUTS.nearby_stops>
				const location = context.location
				if (!location)
					return this.error(
						"The user has not shared their location with this message. Ask them to share it, or to name a stop.",
					)
				const data = this.transit.nearby({
					lat: location.lat,
					lon: location.lon,
					radius: i.radius_m ?? 500,
					network: i.network ?? context.network,
					limit: 10,
				})
				return this.ok(
					{ items: data.items.map(withoutCoords) },
					{ kind: "nearby", data },
				)
			}
		}
	}

	private ok(result: unknown, card: AssistantCard): ToolOutcome {
		return { content: JSON.stringify(result), isError: false, card }
	}

	private error(message: string): ToolOutcome {
		return { content: JSON.stringify({ error: message }), isError: true }
	}
}
