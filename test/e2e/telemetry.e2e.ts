import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { TelemetryRepository } from "@services/telemetry/telemetry.repository"
import { createTestApp, type TestApp } from "../helpers/app"

let t: TestApp

type Body = { ok: boolean; data: { accepted: boolean }; error: { code: string } }

const today = () => new Date().toISOString().slice(0, 10)

function post(body: unknown) {
	return t.json<Body>("/v1/telemetry/counters", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})
}

beforeAll(async () => {
	t = await createTestApp()
}, 60_000)
afterAll(async () => {
	await t.close()
})

describe("telemetry counters", () => {
	test("adds counts into aggregate rows without any identifier", async () => {
		const base = { day: today(), platform: "ios", app_version: "1.0.0", city: null }
		const first = await post({ ...base, counters: { "app.open": 3, "search.query": 1 } })
		expect(first.status).toBe(200)
		expect(first.body.data).toEqual({ accepted: true })
		expect((await post({ ...base, counters: { "app.open": 2 } })).status).toBe(200)
		const totals = t.app.get(TelemetryRepository).totals(today())
		expect(totals).toEqual({ "app.open": 5, "search.query": 1 })
	})

	test("rejects unknown cities, far-off days, bad keys and too many counters", async () => {
		const base = { day: today(), platform: "android", app_version: "1.0.0", city: null }
		expect((await post({ ...base, city: "atlantis", counters: { a: 1 } })).status).toBe(400)
		expect((await post({ ...base, day: "2001-01-01", counters: { a: 1 } })).status).toBe(400)
		expect((await post({ ...base, counters: { "Bad Key": 1 } })).status).toBe(400)
		expect((await post({ ...base, counters: { a: 1_000_000 } })).status).toBe(400)
		const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 1]))
		expect((await post({ ...base, counters: many })).status).toBe(400)
		expect((await post({ ...base, platform: "web", counters: { a: 1 } })).status).toBe(400)
	})

	test("accepts a known city slug", async () => {
		const cities = await t.json<{ data: { slug: string }[] }>("/v1/cities")
		const slug = cities.body.data[0]!.slug
		const res = await post({
			day: today(),
			platform: "android",
			app_version: "1.2.0",
			city: slug,
			counters: { "nearby.open": 1 },
		})
		expect(res.status).toBe(200)
	})
})
