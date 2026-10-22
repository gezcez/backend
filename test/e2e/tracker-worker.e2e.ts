import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestApp, type TestApp } from "../helpers/app"
import { accessTokenFor } from "../helpers/oauth-client"

// The tracker in a real Bun Worker (MODE=all default), driven through the dashboard endpoints.
let t: TestApp
let token: string
let analyst: string

type Body<T> = { ok: boolean; data: T; error: { code: string } }

beforeAll(async () => {
	t = await createTestApp({ TRACKER_RUNNER: "worker" })
	token = (await accessTokenFor(t, "netadmin@test.gezcez.com")).accessToken
	analyst = (await accessTokenFor(t, "analyst@test.gezcez.com")).accessToken
	// Wait for the worker to boot.
	for (let i = 0; i < 100; i++) {
		const ready = await t.json<{ ready: boolean }>("/ready")
		if (ready.body.ready) break
		await Bun.sleep(100)
	}
})
afterAll(async () => {
	await t.close()
})

function get<T>(path: string, who = token) {
	return t.json<Body<T>>(path, { headers: { authorization: `Bearer ${who}` } })
}

describe("tracker worker", () => {
	test("is ready and reports its bindings", async () => {
		const ready = await t.json<{ ready: boolean; checks: { name: string; ok: boolean }[] }>(
			"/ready",
		)
		expect(ready.body.checks).toContainEqual({ name: "tracker", ok: true })
		const overview = await get<{
			runner: string
			running: boolean
			bindings: { binding_id: number; state: string; credentials: unknown }[]
		}>("/v1/dash/networks/kocaeli-ulasimpark/tracker", analyst)
		expect(overview.status).toBe(200)
		expect(overview.body.data).toMatchObject({ runner: "worker", running: true })
		expect(overview.body.data.bindings).toHaveLength(1)
	})

	test("poll now is answered by the worker and lands in the poll log", async () => {
		const overview = await get<{ bindings: { binding_id: number }[] }>(
			"/v1/dash/networks/kocaeli-ulasimpark/tracker",
		)
		const id = overview.body.data.bindings[0]!.binding_id
		const denied = await t.json(`/v1/dash/networks/kocaeli-ulasimpark/bindings/${id}/control`, {
			method: "POST",
			headers: { authorization: `Bearer ${analyst}`, "content-type": "application/json" },
			body: JSON.stringify({ action: "poll-now" }),
		})
		expect(denied.status).toBe(403)
		const result = await t.json<Body<{ ok: boolean; status: { state: string } }>>(
			`/v1/dash/networks/kocaeli-ulasimpark/bindings/${id}/control`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ action: "poll-now", reason: "e2e" }),
			},
		)
		expect(result.status).toBe(200)
		expect(result.body.data.ok).toBe(true)
		expect(result.body.data.status.state).toBe("ok")
		const polls = await get<{ items: { outcome: string }[] }>(
			`/v1/dash/networks/kocaeli-ulasimpark/bindings/${id}/polls?limit=5`,
		)
		expect(["ok", "empty"]).toContain(polls.body.data.items[0]!.outcome)
		const stats = await get<{ success_rate: number }>(
			`/v1/dash/networks/kocaeli-ulasimpark/bindings/${id}/stats`,
		)
		expect(stats.body.data.success_rate).toBe(1)

		const paused = await t.json<Body<{ status: { state: string } }>>(
			`/v1/dash/networks/kocaeli-ulasimpark/bindings/${id}/control`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ action: "pause" }),
			},
		)
		expect(paused.body.data.status.state).toBe("paused")
	})
})
