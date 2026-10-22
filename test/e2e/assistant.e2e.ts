// Trip assistant over HTTP: flag and kill switch, scope, validation, the SSE stream with real
// transit tools behind a mocked SDK client, upstream failure, and the per-account rate limit.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type Anthropic from "@anthropic-ai/sdk"
import { AnthropicClient, type AssistantLlm } from "@services/assistant/anthropic.client"
import { AppConfigRepository } from "@services/app-config/app-config.repository"
import { AppConfigService } from "@services/app-config/app-config.service"
import { NetworksService } from "@services/networks/networks.service"
import { TransitSyncService } from "@services/transit/transit-sync.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { FIXTURE } from "../helpers/dash"
import { accessTokenFor } from "../helpers/oauth-client"

type Params = Anthropic.Beta.MessageCreateParamsStreaming
type Envelope = { ok: boolean; error?: { code: string } }
type Step = { content: Record<string, unknown>[]; stop: string } | Error

let t: TestApp
let token: string
let bindingId: number
const calls: Params[] = []
const script: Step[] = []

/** Scripted stand-in for the SDK: no request leaves the process. */
const fakeLlm = {
	beta: {
		messages: {
			stream(params: Params) {
				calls.push(structuredClone(params))
				const step = script.shift() ?? new Error("script exhausted")
				return {
					async *[Symbol.asyncIterator]() {
						if (step instanceof Error) throw step
						for (const block of step.content)
							if (block.type === "text")
								yield {
									type: "content_block_delta",
									index: 0,
									delta: { type: "text_delta", text: block.text },
								}
					},
					finalMessage: async () => {
						if (step instanceof Error) throw step
						return {
							content: step.content,
							stop_reason: step.stop,
							usage: { input_tokens: 50, output_tokens: 5 },
						}
					},
				}
			},
		},
	},
} as unknown as AssistantLlm

function ask(body: unknown, as: string | null = token) {
	return t.fetch("/v1/assistant/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(as ? { authorization: `Bearer ${as}` } : {}),
		},
		body: JSON.stringify(body),
	})
}

async function events(res: Response) {
	const raw = await res.text()
	return raw
		.split("\n\n")
		.filter((frame) => frame.startsWith("event:"))
		.map((frame) => {
			const [eventLine, dataLine] = frame.split("\n")
			const data = JSON.parse(dataLine!.slice("data: ".length))
			expect(eventLine).toBe(`event: ${data.type}`)
			return data as { type: string; [key: string]: unknown }
		})
}

const question = (content: string, context?: Record<string, unknown>) => ({
	messages: [{ role: "user", content }],
	...(context ? { context } : {}),
})

beforeAll(async () => {
	t = await createTestApp({
		ASSISTANT_ENABLED: "true",
		ANTHROPIC_API_KEY: "sk-ant-e2e-dummy",
		// 6 assistant requests per account per 10 minutes (and room for two sign-ins).
		RATE_LIMIT_SCALE: "0.6",
	})
	t.app.get(AnthropicClient).use(fakeLlm)
	bindingId = t.app.get(NetworksService).bindings()[0]!.id
	expect((await t.app.get(TransitSyncService).sync(bindingId, "manual")).status).toBe("ok")
	token = (
		await accessTokenFor(t, FIXTURE.rider, { clientId: "e2e_client", scope: "openid transit" })
	).accessToken
}, 60_000)
afterAll(async () => {
	await t.close()
})

describe("POST /v1/assistant/messages", () => {
	test("is off by default", async () => {
		const off = await createTestApp()
		try {
			const offToken = (
				await accessTokenFor(off, FIXTURE.rider, {
					clientId: "e2e_client",
					scope: "openid transit",
				})
			).accessToken
			const res = await off.json<Envelope>("/v1/assistant/messages", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${offToken}` },
				body: JSON.stringify(question("hi")),
			})
			expect(res.status).toBe(503)
			expect(res.body.error?.code).toBe("FEATURE_DISABLED")
			const config = await off.json<{ data: { kill_switches: Record<string, boolean> } }>(
				"/v1/app/config",
			)
			expect(config.body.data.kill_switches.assistant).toBe(false)
		} finally {
			await off.close()
		}
	}, 60_000)

	test("needs a token with the transit scope", async () => {
		expect((await ask(question("hi"), null)).status).toBe(401)
		const dash = (await accessTokenFor(t, FIXTURE.rider)).accessToken
		const res = await ask(question("hi"), dash)
		expect(res.status).toBe(403)
		expect(((await res.json()) as Envelope).error?.code).toBe("SCOPE_MISSING")
	})

	test("validates the conversation", async () => {
		const res = await ask({ messages: [{ role: "assistant", content: "hi" }] })
		expect(res.status).toBe(400)
		expect(((await res.json()) as Envelope).error?.code).toBe("VALIDATION_FAILED")
		const far = await ask(question("hi", { location: { lat: 95, lon: 0 } }))
		expect(far.status).toBe(400)
	})

	test("the runtime kill switch turns it off", async () => {
		const repo = t.app.get(AppConfigRepository)
		const appConfig = t.app.get(AppConfigService)
		repo.set("app.kill_switches", { assistant: false })
		appConfig.invalidate()
		const res = await ask(question("hi"))
		expect(res.status).toBe(503)
		expect(((await res.json()) as Envelope).error?.code).toBe("FEATURE_DISABLED")
		repo.set("app.kill_switches", {})
		appConfig.invalidate()
		const config = await t.json<{ data: { kill_switches: Record<string, boolean> } }>(
			"/v1/app/config",
		)
		expect(config.body.data.kill_switches.assistant).toBe(true)
	})

	test("streams tool cards and text over real transit data", async () => {
		const stopId = `${bindingId}.900101`
		script.push(
			{
				content: [
					{ type: "tool_use", id: "tu_1", name: "stop_departures", input: { stop_id: stopId } },
					{ type: "tool_use", id: "tu_2", name: "nearby_stops", input: { radius_m: 700 } },
				],
				stop: "tool_use",
			},
			{ content: [{ type: "text", text: "F1 leaves soon." }], stop: "end_turn" },
		)
		const res = await ask(
			question("F1 Durak 2'den sonraki otobüs?", {
				city: "kocaeli",
				network: "kocaeli-ulasimpark",
				location: { lat: 40.7654, lon: 29.9408 },
			}),
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toStartWith("text/event-stream")
		expect(res.headers.get("cache-control")).toBe("no-store, no-transform")
		const list = await events(res)
		expect(list.map((e) => e.type)).toEqual([
			"start",
			"tool",
			"tool",
			"card",
			"tool",
			"tool",
			"card",
			"text",
			"done",
		])
		const cards = list.filter((e) => e.type === "card") as {
			card: { kind: string; data: Record<string, unknown> }
		}[]
		expect(cards.map((c) => c.card.kind)).toEqual(["departures", "nearby"])
		expect((cards[0]!.card.data.stop as { name: string }).name).toBe("F1 Durak 2")
		expect((cards[1]!.card.data.items as unknown[]).length).toBeGreaterThan(0)
		expect(list.at(-1)).toEqual({
			type: "done",
			stop_reason: "end_turn",
			usage: { input_tokens: 100, output_tokens: 10 },
		})

		// The model got both results in one message, without any coordinates.
		expect(calls).toHaveLength(2)
		const results = calls[1]!.messages[2]!.content as Anthropic.Beta.BetaToolResultBlockParam[]
		expect(results.map((r) => r.tool_use_id)).toEqual(["tu_1", "tu_2"])
		expect(results.every((r) => !r.is_error)).toBe(true)
		const sent = JSON.stringify(calls)
		expect(sent).not.toContain("40.7654")
		expect(sent).not.toContain("29.9408")
		expect(sent).not.toMatch(/"lat"|"lon"/)
		expect(sent).toContain("kocaeli-ulasimpark")
	})

	test("an upstream failure ends the stream with an error event", async () => {
		script.push(new Error("boom"))
		const res = await ask(question("hi"))
		expect(res.status).toBe(200)
		const list = await events(res)
		expect(list.at(-1)).toEqual({
			type: "error",
			code: "ASSISTANT_UNAVAILABLE",
			message: "The assistant is unavailable",
		})
	})

	test("is rate limited per account", async () => {
		// Two requests above already counted; the limit is 6 per 10 minutes at this scale.
		let res: Response | undefined
		let accepted = 2
		for (let i = 0; i < 10; i++) {
			script.push({ content: [{ type: "text", text: "ok" }], stop: "end_turn" })
			res = await ask(question("hi"))
			if (res.status === 429) break
			expect(res.status).toBe(200)
			await res.text()
			accepted++
		}
		script.length = 0
		expect(accepted).toBe(6)
		res = res!
		expect(res.status).toBe(429)
		const body = (await res.json()) as Envelope & { error: { details: { retry_after: number } } }
		expect(body.error.code).toBe("RATE_LIMITED")
		expect(body.error.details.retry_after).toBeGreaterThan(0)
	})
})
