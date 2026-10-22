import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import type { RawVehicle } from "@services/providers/transit-provider.interface"
import { TrackerHostService } from "@services/tracker/tracker-host.service"
import { TransitSyncService } from "@services/transit/transit-sync.service"
import { createTestApp, type TestApp } from "../helpers/app"

let t: TestApp
let bindingId: number
const now = Math.floor(Date.now() / 1000)

type Body<T> = { ok: boolean; data: T; error: { code: string } }

function vehicle(id: string, extra: Partial<RawVehicle> = {}): RawVehicle {
	return {
		externalId: id,
		plate: `41 V ${id}`,
		label: "F1 Kuzey",
		lat: 40.7654,
		lon: 29.9408,
		bearing: 91,
		speedMs: 6.04,
		routeExt: "9001",
		direction: 0,
		tripExt: "LIVE1",
		stopExt: "900101",
		stopSeq: 2,
		status: 2,
		vehicleTs: now - 5,
		...extra,
	}
}

beforeAll(async () => {
	t = await createTestApp({ TRACKER_RUNNER: "manual" })
	const networks = t.app.get(NetworksService)
	bindingId = networks.bindings(networks.network("kocaeli-ulasimpark").id)[0]!.id
	await t.app.get(TransitSyncService).sync(bindingId, "manual")
	t.app.get(ProvidersRegistry).fake.script(bindingId, [
		{
			feedTs: now,
			urlVariant: "primary",
			bytes: 0,
			invalid: 0,
			entities: [
				vehicle("V1"),
				vehicle("V2", { routeExt: "9002", lat: 40.9, stopSeq: 1, tripExt: "0" }),
			],
		},
	])
	await t.app.get(TrackerHostService).inlineEngine()!.pollOnce(bindingId)
})
afterAll(async () => {
	await t.close()
})

describe("live vehicles REST", () => {
	test("snapshot uses compact arrays in field order", async () => {
		const res = await t.json<
			Body<{ fields: string[]; vehicles: unknown[][]; feed_ts: number }>
		>("/v1/networks/kocaeli-ulasimpark/vehicles")
		expect(res.status).toBe(200)
		expect(res.headers.get("cache-control")).toBe("public, max-age=5")
		const { fields, vehicles, feed_ts } = res.body.data
		expect(feed_ts).toBe(now)
		expect(fields).toEqual([
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
		])
		const v1 = vehicles.find((v) => v[0] === `${bindingId}.V1`)!
		expect(v1).toEqual([
			`${bindingId}.V1`,
			40.7654,
			29.9408,
			91,
			6,
			`${bindingId}.9001`,
			0,
			`${bindingId}.LIVE1`,
			2,
			2,
			now - 5,
			0,
		])
		// No plate in the compact form.
		expect(JSON.stringify(res.body)).not.toContain("41 V")
	})

	test("filters by route, direction and bbox; validates params", async () => {
		const byRoute = await t.json<Body<{ vehicles: unknown[][] }>>(
			`/v1/networks/kocaeli-ulasimpark/vehicles?routes=${bindingId}.9002`,
		)
		expect(byRoute.body.data.vehicles.map((v) => v[0])).toEqual([`${bindingId}.V2`])
		const byBox = await t.json<Body<{ vehicles: unknown[][] }>>(
			"/v1/networks/kocaeli-ulasimpark/vehicles?bbox=29.9,40.7,30.0,40.8",
		)
		expect(byBox.body.data.vehicles.map((v) => v[0])).toEqual([`${bindingId}.V1`])
		const byDirection = await t.json<Body<{ vehicles: unknown[][] }>>(
			"/v1/networks/kocaeli-ulasimpark/vehicles?direction=1",
		)
		expect(byDirection.body.data.vehicles).toEqual([])
		const wide = await t.json<Body<unknown>>(
			"/v1/networks/kocaeli-ulasimpark/vehicles?bbox=29,40,30,41",
		)
		expect(wide.status).toBe(400)
		const foreign = await t.json<Body<unknown>>(
			"/v1/networks/kocaeli-ulasimpark/vehicles?routes=999.1",
		)
		expect(foreign.body.error.code).toBe("VALIDATION_FAILED")
	})

	test("vehicle detail has the live state and the open run", async () => {
		const res = await t.json<
			Body<{
				plate: string
				live: boolean
				route: { short_name: string }
				current_run: { trip_id: string; ended_at: null }
				runs_today: unknown[]
			}>
		>(`/v1/vehicles/${bindingId}.V1`)
		expect(res.status).toBe(200)
		expect(res.body.data).toMatchObject({
			plate: "41 V V1",
			live: true,
			route: { short_name: "F1" },
			current_run: { trip_id: `${bindingId}.LIVE1`, ended_at: null },
		})
		expect((await t.json(`/v1/vehicles/${bindingId}.NOPE`)).status).toBe(404)
	})

	test("departures merge the approaching vehicle with its ETA", async () => {
		// Stop 5 of route 9001 direction 0 is external id 900104; the vehicle is heading to seq 2.
		const res = await t.json<
			Body<{
				items: {
					vehicle_id: string | null
					stops_away: number | null
					predicted_at: string | null
					source: string
					route: { short_name: string }
				}[]
			}>
		>(`/v1/stops/${bindingId}.900104/departures?limit=50`)
		expect(res.status).toBe(200)
		const live = res.body.data.items.find((i) => i.vehicle_id === `${bindingId}.V1`)!
		expect(live).toMatchObject({ stops_away: 3, route: { short_name: "F1" } })
		expect(["live_eta", "live"]).toContain(live.source)
		const eta = Date.parse(live.predicted_at!) / 1000
		expect(Math.abs(eta - (Math.floor(Date.now() / 1000) + 360))).toBeLessThan(5)
		for (const item of res.body.data.items.filter((i) => i.vehicle_id === null))
			expect(item.source).toBe("schedule")
	})

	test("history departures answers for a route", async () => {
		const res = await t.json<Body<{ items: unknown[]; date: string }>>(
			`/v1/routes/${bindingId}.9001/history/departures?direction=0`,
		)
		expect(res.status).toBe(200)
		expect(res.body.data.items).toEqual([])
	})
})
