import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { decodePolyline } from "@common/utils"
import { NetworksService } from "@services/networks/networks.service"
import { TransitSyncService } from "@services/transit/transit-sync.service"
import { createTestApp, type TestApp } from "../helpers/app"

let t: TestApp
let bindingId: number

type Envelope<T> = { ok: boolean; data: T; error?: { code: string } }

beforeAll(async () => {
	t = await createTestApp()
	bindingId = t.app.get(NetworksService).bindings()[0]!.id
})
afterAll(async () => {
	await t.close()
})

describe("catalog before the first sync", () => {
	test("GET /v1/cities lists Kocaeli with its network and no static data yet", async () => {
		const res = await t.json<
			Envelope<
				{
					slug: string
					centre: number[]
					bbox: number[]
					networks: { slug: string; status: string; modes: string[] }[]
				}[]
			>
		>("/v1/cities")
		expect(res.status).toBe(200)
		const city = res.body.data.find((c) => c.slug === "kocaeli")!
		expect(city.centre).toEqual([29.9408, 40.7654])
		expect(city.bbox).toHaveLength(4)
		expect(city.networks.map((n) => n.slug)).toContain("kocaeli-ulasimpark")
		expect(city.networks.find((n) => n.slug === "kocaeli-ulasimpark")!.modes).toEqual([])
	})

	test("the manifest says static capabilities are off until synced", async () => {
		const res = await t.json<
			Envelope<{
				networks: {
					slug: string
					status: string
					capabilities: { stops: boolean; realtime_vehicles: boolean }
					pack_version: string | null
				}[]
			}>
		>("/v1/cities/kocaeli/manifest")
		const network = res.body.data.networks.find((n) => n.slug === "kocaeli-ulasimpark")!
		expect(network.capabilities.stops).toBe(false)
		expect(network.capabilities.realtime_vehicles).toBe(true)
		expect(network.pack_version).toBeNull()
		// The second fixture network has no binding at all.
		expect(res.body.data.networks.find((n) => n.slug === "test-network-b")?.status).toBe(
			"disabled",
		)
	})
})

describe("after a static sync", () => {
	beforeAll(async () => {
		const result = await t.app.get(TransitSyncService).sync(bindingId, "manual")
		expect(result.status).toBe("ok")
	})

	test("a second sync with identical data is a no-op", async () => {
		const result = await t.app.get(TransitSyncService).sync(bindingId, "manual")
		expect(result.status).toBe("unchanged")
	})

	test("manifest: capabilities, modes, pack_version, privacy and ETag with 304", async () => {
		const res = await t.json<
			Envelope<{
				city: { slug: string }
				networks: {
					slug: string
					status: string
					modes: string[]
					pack_version: string
					capabilities: { stops: boolean; timetables: boolean }
					attribution: { provider: string }[]
					privacy: unknown[]
					freshness: { static_synced_at: string }
				}[]
				route_types: { mode: string; label: { tr: string } }[]
			}>
		>("/v1/cities/kocaeli/manifest")
		const network = res.body.data.networks.find((n) => n.slug === "kocaeli-ulasimpark")!
		expect(network.status).toBe("active")
		expect(network.modes).toEqual(["bus", "tram"])
		expect(network.capabilities).toMatchObject({ stops: true, timetables: true })
		expect(network.pack_version).toMatch(/^\d+-\d+$/)
		expect(network.attribution[0]!.provider).toBe("fake")
		expect(network.freshness.static_synced_at).toBeTruthy()
		expect(res.body.data.route_types.find((r) => r.mode === "tram")?.label.tr).toBe("Tramvay")
		const etag = res.headers.get("etag")!
		expect(etag).toMatch(/^".+"$/)
		const again = await t.fetch("/v1/cities/kocaeli/manifest", {
			headers: { "if-none-match": etag },
		})
		expect(again.status).toBe(304)
	})

	test("GET /v1/networks/:networkId accepts slug and numeric id", async () => {
		const bySlug = await t.json<Envelope<{ id: number; slug: string }>>(
			"/v1/networks/kocaeli-ulasimpark",
		)
		expect(bySlug.status).toBe(200)
		const byId = await t.json<Envelope<{ slug: string }>>(`/v1/networks/${bySlug.body.data.id}`)
		expect(byId.body.data.slug).toBe("kocaeli-ulasimpark")
		const missing = await t.json<Envelope<null>>("/v1/networks/nope")
		expect(missing.status).toBe(404)
		expect(missing.body.error?.code).toBe("NOT_FOUND")
	})

	test("routes list with the pagination contract", async () => {
		const all = await t.json<
			Envelope<{ items: { id: string; short_name: string; mode: string }[]; total: number }>
		>("/v1/networks/kocaeli-ulasimpark/routes")
		expect(all.body.data.items.map((r) => r.short_name)).toEqual(["F1", "F2", "T1"])
		expect(all.body.data.items[0]!.id).toBe(`${bindingId}.9001`)
		const page1 = await t.json<
			Envelope<{ items: { short_name: string }[]; next_cursor: string; total: number }>
		>("/v1/networks/kocaeli-ulasimpark/routes?limit=2")
		expect(page1.body.data.items).toHaveLength(2)
		expect(page1.body.data.total).toBe(3)
		const page2 = await t.json<
			Envelope<{ items: { short_name: string }[]; next_cursor: string | null }>
		>(`/v1/networks/kocaeli-ulasimpark/routes?limit=2&cursor=${page1.body.data.next_cursor}`)
		expect(page2.body.data.items.map((r) => r.short_name)).toEqual(["T1"])
		expect(page2.body.data.next_cursor).toBeNull()
		const stale = await t.json<Envelope<null>>(
			`/v1/networks/kocaeli-ulasimpark/routes?limit=2&type=0&cursor=${page1.body.data.next_cursor}`,
		)
		expect(stale.status).toBe(400)
		const trams = await t.json<Envelope<{ items: { short_name: string }[] }>>(
			"/v1/networks/kocaeli-ulasimpark/routes?type=0",
		)
		expect(trams.body.data.items.map((r) => r.short_name)).toEqual(["T1"])
	})

	test("route detail, shape and timetable", async () => {
		const id = `${bindingId}.9001`
		const detail = await t.json<
			Envelope<{
				directions: {
					direction: number
					patterns: { stops: { id: string; offset_s: number }[] }[]
				}[]
			}>
		>(`/v1/routes/${id}`)
		expect(detail.status).toBe(200)
		expect(detail.body.data.directions).toHaveLength(2)
		const stops = detail.body.data.directions[0]!.patterns[0]!.stops
		expect(stops).toHaveLength(8)
		expect(stops[1]!.offset_s).toBe(120)

		const shape = await t.json<
			Envelope<{ precision: number; shapes: { direction: number; polyline: string }[] }>
		>(`/v1/routes/${id}/shape?direction=1`)
		expect(shape.body.data.shapes).toHaveLength(1)
		expect(decodePolyline(shape.body.data.shapes[0]!.polyline)).toHaveLength(8)

		const sunday = await t.json<
			Envelope<{ day_type: string; patterns: { departures: { start: string }[] }[] }>
		>(`/v1/routes/${id}/timetable?day_type=sunday&direction=0`)
		expect(sunday.body.data.day_type).toBe("sunday")
		expect(sunday.body.data.patterns[0]!.departures[0]!.start).toBe("06:00")
		expect(sunday.body.data.patterns[0]!.departures).toHaveLength(69)

		const byDate = await t.json<Envelope<{ date: string; day_type: string }>>(
			`/v1/routes/${id}/timetable?date=2026-10-24`,
		)
		expect(byDate.body.data).toMatchObject({ date: "2026-10-24", day_type: "saturday" })

		expect((await t.fetch("/v1/routes/not-an-id")).status).toBe(404)
		expect((await t.fetch(`/v1/routes/${bindingId}.0000`)).status).toBe(404)
	})

	test("stops: list with bbox, detail with serving routes", async () => {
		const page = await t.json<
			Envelope<{ items: { id: string; lat: number; lon: number }[]; total: number }>
		>("/v1/networks/kocaeli-ulasimpark/stops?limit=200")
		expect(page.body.data.total).toBe(24)
		const inBox = await t.json<Envelope<{ items: unknown[] }>>(
			"/v1/networks/kocaeli-ulasimpark/stops?bbox=29.93,40.76,29.95,40.77",
		)
		expect(inBox.body.data.items.length).toBeGreaterThan(0)
		expect(inBox.body.data.items.length).toBeLessThan(24)
		const bad = await t.json<Envelope<null>>("/v1/networks/kocaeli-ulasimpark/stops?bbox=1,2,3")
		expect(bad.status).toBe(400)
		const stop = await t.json<Envelope<{ name: string; routes: { short_name: string }[] }>>(
			`/v1/stops/${bindingId}.900101`,
		)
		expect(stop.body.data.name).toBe("F1 Durak 2")
		expect(stop.body.data.routes.map((r) => r.short_name)).toEqual(["F1"])
	})

	test("nearby stops are sorted by distance and bounded by the radius", async () => {
		const res = await t.json<
			Envelope<{ items: { distance_m: number; route_ids: string[] }[] }>
		>("/v1/stops/nearby?lat=40.7654&lon=29.9408&radius=700")
		const items = res.body.data.items
		expect(items.length).toBeGreaterThan(3)
		expect(items.every((s) => s.distance_m <= 700)).toBe(true)
		expect([...items].sort((a, b) => a.distance_m - b.distance_m)).toEqual(items)
		expect(items[0]!.route_ids.length).toBeGreaterThan(0)
		expect((await t.fetch("/v1/stops/nearby?lat=95&lon=1")).status).toBe(400)
	})

	test("search folds Turkish characters", async () => {
		const res = await t.json<Envelope<{ routes: { short_name: string }[]; stops: unknown[] }>>(
			"/v1/search?q=dogu&city=kocaeli",
		)
		expect(res.body.data.routes.map((r) => r.short_name)).toEqual(["F2"])
		const stops = await t.json<Envelope<{ routes: unknown[]; stops: { name: string }[] }>>(
			"/v1/search?q=durak%203&network=kocaeli-ulasimpark",
		)
		expect(stops.body.data.stops.map((s) => s.name)).toContain("F1 Durak 3")
		const empty = await t.json<Envelope<{ routes: unknown[] }>>("/v1/search?q=%22%22")
		expect(empty.body.data.routes).toEqual([])
	})

	test("GET /v1/providers lists what each provider collects", async () => {
		const res =
			await t.json<Envelope<{ key: string; pulled_data: unknown[] }[]>>("/v1/providers")
		expect(res.body.data.map((p) => p.key)).toEqual(["fake", "kentkart"])
		expect(JSON.stringify(res.body)).not.toContain("secret")
	})
})
