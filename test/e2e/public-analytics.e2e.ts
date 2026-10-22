import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { addDays, localTime } from "@common/utils"
import { DatabaseService } from "@db"
import { NetworksService } from "@services/networks/networks.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { buildFixture, FIXTURE_TZ, insertFixture, POSITIONS_PER_DAY } from "../helpers/vts-fixtures"

let t: TestApp
const today = localTime(Math.floor(Date.now() / 1000), FIXTURE_TZ).date
const yesterday = addDays(today, -1)
const dayBefore = addDays(today, -2)

type Body<T> = { ok: boolean; data: T; error: { code: string } }

beforeAll(async () => {
	t = await createTestApp()
	const networks = t.app.get(NetworksService)
	const bindingId = networks.bindings(networks.network("kocaeli-ulasimpark").id)[0]!.id
	insertFixture(
		t.app.get(DatabaseService).vts.$client,
		bindingId,
		buildFixture([dayBefore, yesterday]),
	)
}, 60_000)
afterAll(async () => {
	await t.close()
})

const round1 = (value: number) => Math.round(value * 10) / 10

describe("public analytics", () => {
	test("quality: daily reliability score per city, anonymous and cached for an hour", async () => {
		const res = await t.json<
			Body<{
				from: string
				to: string
				cities: {
					slug: string
					score: number | null
					networks: {
						id: string
						score: number | null
						days: { date: string; score: number }[]
					}[]
				}[]
			}>
		>("/v1/public/analytics/quality?city=kocaeli&days=3")
		expect(res.status).toBe(200)
		expect(res.headers.get("cache-control")).toBe("public, max-age=3600")
		expect(res.body.data).toMatchObject({ from: addDays(today, -3), to: yesterday })
		const [city] = res.body.data.cities
		expect(city!.slug).toBe("kocaeli")
		const network = city!.networks.find((n) => n.id === "kocaeli-ulasimpark")!
		// No catalogue synced (coverage counts as 1); one upstream error on the first day.
		const stale = 1 / POSITIONS_PER_DAY
		const first = round1(100 * (0.4 * (100 / 101) + 0.3 * (1 - stale) + 0.3))
		const second = round1(100 * (0.4 + 0.3 * (1 - stale) + 0.3))
		expect(network.days.map((d) => [d.date, d.score])).toEqual([
			[dayBefore, first],
			[yesterday, second],
		])
		expect(network.score).toBe(round1((first + second) / 2))
		expect(city!.score).toBe(network.score)
		// Aggregates only: no vehicle or trip identifiers.
		expect(JSON.stringify(res.body)).not.toMatch(/V1|41 FX|T1/)
	})

	test("fleet: today and yesterday per public network", async () => {
		const res = await t.json<
			Body<{
				networks: {
					id: string
					today: { date: string; vehicles: number }
					yesterday: {
						date: string
						vehicles: number
						peak_vehicles: number
						vehicle_hours: number
						hours: [number, number][]
					}
				}[]
			}>
		>("/v1/public/analytics/fleet?city=kocaeli")
		expect(res.status).toBe(200)
		expect(res.headers.get("cache-control")).toBe("public, max-age=600")
		const network = res.body.data.networks.find((n) => n.id === "kocaeli-ulasimpark")!
		expect(network.today).toMatchObject({ date: today, vehicles: 0 })
		expect(network.yesterday).toEqual({
			date: yesterday,
			vehicles: 4,
			peak_vehicles: 3,
			vehicle_hours: 1.5,
			hours: [
				[8, 3],
				[9, 1],
			],
		})
	})

	test("unknown city and bad parameters", async () => {
		expect((await t.fetch("/v1/public/analytics/fleet?city=nowhere")).status).toBe(404)
		expect((await t.fetch("/v1/public/analytics/quality?days=99")).status).toBe(400)
	})
})
