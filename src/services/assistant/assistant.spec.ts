import { describe, expect, test } from "bun:test"
import Anthropic from "@anthropic-ai/sdk"
import { loadConfig } from "@common/config"
import type { AppConfigService } from "@services/app-config/app-config.service"
import type { TransitService } from "@services/transit/transit.service"
import type { VehiclesService } from "@services/vehicles/vehicles.service"
import { AssistantMessagesBodySchema, type AssistantStreamEvent } from "./assistant.dto"
import { AssistantService, afterLastFallback, echoable } from "./assistant.service"
import { AssistantTools } from "./assistant.tools"
import { AnthropicClient, type AssistantLlm } from "./anthropic.client"

type Block = Anthropic.Beta.BetaContentBlock
type Params = Anthropic.Beta.MessageCreateParamsStreaming

const API_KEY = "sk-ant-test-never-sent-0000"
const USER_LAT = 38.41921
const USER_LON = 27.12873

const STOP = { id: "1.900100", network_id: 1, name: "Konak", code: "10001", lat: 38.4189, lon: 27.1287 }
const ROUTE = {
	id: "1.42041",
	network_id: 1,
	short_name: "41",
	long_name: "Konak - Bornova",
	mode: "bus",
	route_type: 3,
	colour: null,
	text_colour: null,
	agency: null,
}

function message(content: Block[], stop: Anthropic.Beta.BetaStopReason): Anthropic.Beta.BetaMessage {
	return {
		id: "msg_test",
		type: "message",
		role: "assistant",
		model: "test-model",
		content,
		stop_reason: stop,
		stop_sequence: null,
		usage: { input_tokens: 100, output_tokens: 10 },
	} as unknown as Anthropic.Beta.BetaMessage
}

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block
const toolUse = (id: string, name: string, input: unknown) =>
	({ type: "tool_use", id, name, input }) as Block

/** A fake SDK: each stream() call plays the next scripted message and records its params. */
function fakeLlm(script: (Anthropic.Beta.BetaMessage | Error)[]) {
	const calls: Params[] = []
	const llm = {
		beta: {
			messages: {
				stream(params: Params) {
					calls.push(structuredClone(params))
					const next = script.shift()
					if (!next) throw new Error("script exhausted")
					return {
						async *[Symbol.asyncIterator]() {
							if (next instanceof Error) throw next
							for (const block of next.content)
								if (block.type === "text")
									yield {
										type: "content_block_delta",
										index: 0,
										delta: { type: "text_delta", text: block.text },
									}
						},
						finalMessage: async () => {
							if (next instanceof Error) throw next
							return next
						},
					}
				},
			},
		},
	}
	return { llm: llm as unknown as AssistantLlm, calls }
}

function setup(script: (Anthropic.Beta.BetaMessage | Error)[], env: Record<string, string> = {}) {
	const config = loadConfig({
		NODE_ENV: "test",
		ASSISTANT_ENABLED: "true",
		ANTHROPIC_API_KEY: API_KEY,
		...env,
	})
	const seen: { nearby: unknown[] } = { nearby: [] }
	const transit = {
		search: () => ({ routes: [ROUTE], stops: [STOP] }),
		stopDetail: () => ({ ...STOP, routes: [ROUTE] }),
		routeDetail: () => ({
			...ROUTE,
			directions: [
				{
					direction: 0,
					headsign: "Bornova",
					patterns: [
						{
							id: "p1",
							headsign: "Bornova",
							length_m: 9000,
							stops: [{ ...STOP, seq: 1, offset_s: 0 }],
						},
					],
				},
			],
		}),
		nearby: (query: unknown) => {
			seen.nearby.push(query)
			return { items: [{ ...STOP, distance_m: 120, route_ids: [ROUTE.id] }] }
		},
	} as unknown as TransitService
	const vehicles = {
		departures: () => ({
			stop: STOP,
			generated_at: "2026-10-22T10:00:00+03:00",
			items: [
				{
					route: ROUTE,
					headsign: "Bornova",
					direction: 0,
					trip_id: null,
					scheduled_at: "2026-10-22T10:05:00+03:00",
					predicted_at: "2026-10-22T10:06:00+03:00",
					vehicle_id: "1.555",
					stops_away: 2,
					source: "live_eta",
					cancelled: false,
				},
			],
		}),
	} as unknown as VehiclesService
	const appConfig = {
		config: () => ({ kill_switches: { assistant: true } }),
	} as unknown as AppConfigService
	const { llm, calls } = fakeLlm(script)
	const client = new AnthropicClient(config)
	client.use(llm)
	const service = new AssistantService(
		config,
		appConfig,
		client,
		new AssistantTools(transit, vehicles),
	)
	return { service, calls, seen }
}

function body(content: string, context: Record<string, unknown> = {}) {
	return AssistantMessagesBodySchema.parse({ messages: [{ role: "user", content }], context })
}

async function run(service: AssistantService, b: ReturnType<typeof body>) {
	const events: AssistantStreamEvent[] = []
	await service.respond(b, (e) => events.push(e))
	return events
}

describe("AssistantService", () => {
	test("answers a tool call from the transit services, then streams the answer", async () => {
		const { service, calls } = setup([
			message([toolUse("tu_1", "stop_departures", { stop_id: "1.900100" })], "tool_use"),
			message([text("41 arrives at 10:06.")], "end_turn"),
		])
		const events = await run(service, body("When is the next 41 at Konak?"))
		expect(events.map((e) => e.type)).toEqual(["start", "tool", "tool", "card", "text", "done"])
		expect(events[0]).toEqual({ type: "start", model: "claude-sonnet-5-5" })
		expect(events[2]).toMatchObject({ type: "tool", name: "stop_departures", status: "done" })
		expect(events[3]).toMatchObject({ type: "card", card: { kind: "departures" } })
		expect(events.at(-1)).toEqual({
			type: "done",
			stop_reason: "end_turn",
			usage: { input_tokens: 200, output_tokens: 20 },
		})

		const first = calls[0]!
		expect(first.model).toBe("claude-sonnet-5-5")
		expect(first.betas).toEqual(["server-side-fallback-2026-07-01"])
		expect((first as unknown as { fallbacks: unknown }).fallbacks).toBe("default")
		expect(first.output_config).toEqual({ effort: "low" })
		expect("temperature" in first).toBe(false)
		expect(first.tools?.map((t) => (t as { name: string }).name)).toEqual([
			"search_transit",
			"stop_departures",
			"stop_detail",
			"route_detail",
			"nearby_stops",
		])

		const second = calls[1]!
		expect(second.messages).toHaveLength(3)
		expect(second.messages[1]!.role).toBe("assistant")
		const result = (second.messages[2]!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!
		expect(result.tool_use_id).toBe("tu_1")
		expect(result.is_error).toBeUndefined()
		const payload = JSON.parse(result.content as string)
		expect(payload.items[0]).toMatchObject({ route: "41", source: "live_eta" })
		// The model never sees coordinates.
		expect(payload.stop.lat).toBeUndefined()
	})

	test("nearby uses the coordinates the user sent, and they never reach the model", async () => {
		const { service, calls, seen } = setup([
			message([toolUse("tu_1", "nearby_stops", { radius_m: 400 })], "tool_use"),
			message([text("Konak is 120 m away.")], "end_turn"),
		])
		const events = await run(
			service,
			body("Stops near me?", { location: { lat: USER_LAT, lon: USER_LON } }),
		)
		expect(seen.nearby).toEqual([
			{ lat: USER_LAT, lon: USER_LON, radius: 400, network: undefined, limit: 10 },
		])
		expect(events.find((e) => e.type === "card")).toMatchObject({ card: { kind: "nearby" } })
		const sent = JSON.stringify(calls)
		for (const value of [USER_LAT, USER_LON, STOP.lat, STOP.lon])
			expect(sent).not.toContain(String(value))
		expect(sent).toContain("shared their location")
	})

	test("nearby without a shared location is a tool error, not a guess", async () => {
		const { service, calls, seen } = setup([
			message([toolUse("tu_1", "nearby_stops", {})], "tool_use"),
			message([text("Please share your location.")], "end_turn"),
		])
		await run(service, body("Stops near me?"))
		expect(seen.nearby).toEqual([])
		const result = (calls[1]!.messages[2]!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!
		expect(result.is_error).toBe(true)
		expect(result.content).toContain("not shared their location")
	})

	test("invalid and unknown tool input come back as error results", async () => {
		const { service, calls } = setup([
			message(
				[
					toolUse("tu_1", "route_detail", { route_id: 42 }),
					toolUse("tu_2", "drop_tables", {}),
				],
				"tool_use",
			),
			message([text("Sorry.")], "end_turn"),
		])
		await run(service, body("route?"))
		const results = calls[1]!.messages[2]!.content as Anthropic.Beta.BetaToolResultBlockParam[]
		// Both results of the turn go back in one user message.
		expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
			["tu_1", true],
			["tu_2", true],
		])
	})

	test("a refusal ends the turn without running its tools", async () => {
		const { service, calls } = setup([
			message([toolUse("tu_1", "stop_departures", { stop_id: "1.9" })], "refusal"),
		])
		const events = await run(service, body("..."))
		expect(calls).toHaveLength(1)
		expect(events.some((e) => e.type === "tool")).toBe(false)
		expect(events.at(-1)).toMatchObject({ type: "done", stop_reason: "refusal" })
	})

	test("stops at the round cap", async () => {
		const loop = () => message([toolUse("tu", "search_transit", { query: "41" })], "tool_use")
		const { service, calls } = setup([loop(), loop()], { ASSISTANT_MAX_ROUNDS: "2" })
		const events = await run(service, body("41"))
		expect(calls).toHaveLength(2)
		expect(events.at(-1)).toMatchObject({ type: "done", stop_reason: "max_rounds" })
	})

	test("upstream failures become an error event without the key", async () => {
		const failure = new Anthropic.APIError(529, undefined, "overloaded", new Headers())
		const { service } = setup([failure])
		const events = await run(service, body("hi"))
		expect(events.at(-1)).toEqual({
			type: "error",
			code: "ASSISTANT_UNAVAILABLE",
			message: "The assistant is unavailable",
		})
		expect(JSON.stringify(events)).not.toContain(API_KEY)
	})

	test("ASSISTANT_FALLBACKS=false sends no beta and no fallbacks", async () => {
		const { service, calls } = setup([message([text("ok")], "end_turn")], {
			ASSISTANT_FALLBACKS: "false",
			ASSISTANT_MODEL: "custom-model",
		})
		await run(service, body("hi"))
		expect(calls[0]!.model).toBe("custom-model")
		expect(calls[0]!.betas).toBeUndefined()
		expect("fallbacks" in calls[0]!).toBe(false)
	})
})

describe("fallback boundaries", () => {
	const fallback = { type: "fallback", from: { model: "a" }, to: { model: "b" } } as unknown as Block
	const thinking = { type: "thinking", thinking: "", signature: "s" } as Block
	const content = [thinking, text("partial "), toolUse("old", "search_transit", {}), fallback, text("final")]

	test("only the answering model's blocks count", () => {
		expect(afterLastFallback(content)).toEqual([text("final")])
		expect(afterLastFallback([text("x")])).toEqual([text("x")])
	})

	test("echo keeps text before the marker and drops the declined attempt's other blocks", () => {
		expect(echoable(content)).toEqual([text("partial "), text("final")])
	})
})

describe("AssistantMessagesBodySchema", () => {
	test("needs a user turn first and last", () => {
		expect(
			AssistantMessagesBodySchema.safeParse({ messages: [{ role: "assistant", content: "x" }] })
				.success,
		).toBe(false)
		expect(
			AssistantMessagesBodySchema.safeParse({
				messages: [
					{ role: "user", content: "a" },
					{ role: "assistant", content: "b" },
				],
			}).success,
		).toBe(false)
		const ok = AssistantMessagesBodySchema.parse({ messages: [{ role: "user", content: "a" }] })
		expect(ok.context.locale).toBe("tr")
	})
})
