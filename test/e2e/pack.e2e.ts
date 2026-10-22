import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import { ProviderError } from "@services/providers/transit-provider.interface"
import { AlertsService } from "@services/transit/alerts.service"
import { TransitSyncService } from "@services/transit/transit-sync.service"
import { createTestApp, type TestApp } from "../helpers/app"

let t: TestApp
let bindingId: number

type Body<T> = { ok: boolean; data: T; error: { code: string } }

interface Pack {
	network: string
	pack_version: string
	stops: { id: string; modes: string[]; route_ids: string[]; lat: number }[]
	routes: {
		id: string
		short_name: string
		mode: string
		directions: { direction: number; headsign: string; stop_ids: string[] }[]
	}[]
}

beforeAll(async () => {
	t = await createTestApp()
	const networks = t.app.get(NetworksService)
	bindingId = networks.bindings(networks.network("kocaeli-ulasimpark").id)[0]!.id
})
afterAll(async () => {
	await t.close()
})

describe("network pack", () => {
	test("404 before the first sync", async () => {
		const res = await t.json<Body<unknown>>("/v1/networks/kocaeli-ulasimpark/pack")
		expect(res.status).toBe(404)
	})

	test("stops and routes with directions, matching the manifest's pack_version", async () => {
		await t.app.get(TransitSyncService).sync(bindingId, "manual")
		const res = await t.fetch("/v1/networks/kocaeli-ulasimpark/pack", {
			headers: { "accept-encoding": "gzip" },
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-encoding")).toBe("gzip")
		expect(res.headers.get("cache-control")).toBe("public, max-age=86400")
		const etag = res.headers.get("etag")!
		expect(etag).toMatch(/^"pack-.+"$/)
		const body = (await res.json()) as Body<Pack>
		const pack = body.data
		expect(pack.network).toBe("kocaeli-ulasimpark")
		expect(pack.routes).toHaveLength(3)
		expect(pack.stops).toHaveLength(24)
		const f1 = pack.routes.find((r) => r.short_name === "F1")!
		expect(f1.id).toBe(`${bindingId}.9001`)
		expect(f1.directions.map((d) => d.direction)).toEqual([0, 1])
		expect(f1.directions[0]!.stop_ids).toHaveLength(8)
		expect(f1.directions[0]!.stop_ids[0]).toBe(`${bindingId}.900100`)
		expect(f1.directions[1]!.stop_ids[0]).toBe(`${bindingId}.900107`)
		const stop = pack.stops.find((s) => s.id === `${bindingId}.900300`)!
		expect(stop).toMatchObject({ modes: ["tram"], route_ids: [`${bindingId}.9003`] })

		const manifest = await t.json<Body<{ networks: { slug: string; pack_version: string }[] }>>(
			"/v1/cities/kocaeli/manifest",
		)
		const network = manifest.body.data.networks.find((n) => n.slug === "kocaeli-ulasimpark")!
		expect(network.pack_version).toBe(pack.pack_version)

		const again = await t.fetch("/v1/networks/kocaeli-ulasimpark/pack", {
			headers: { "if-none-match": etag },
		})
		expect(again.status).toBe(304)
		const plain = await t.fetch("/v1/networks/kocaeli-ulasimpark/pack", {
			headers: { "accept-encoding": "identity" },
		})
		expect(plain.headers.get("content-encoding")).toBeNull()
		expect(((await plain.json()) as Body<Pack>).data.pack_version).toBe(pack.pack_version)
	})
})

describe("service alerts", () => {
	test("empty by default; active alerts from the provider with stable ids", async () => {
		const empty = await t.json<Body<unknown[]>>("/v1/networks/kocaeli-ulasimpark/alerts")
		expect(empty.status).toBe(200)
		expect(empty.body.data).toEqual([])

		const now = Math.floor(Date.now() / 1000)
		const fake = t.app.get(ProvidersRegistry).fake
		fake.setAlerts(bindingId, [
			{
				externalId: "a1",
				title: "Yol çalışması",
				body: "F1 güzergahı değişti",
				severity: "warning",
				routeExts: ["9001"],
				activeFrom: now - 60,
				activeTo: null,
				url: null,
			},
			{
				externalId: "old",
				title: "Bitti",
				body: "",
				severity: "info",
				routeExts: [],
				activeFrom: now - 7200,
				activeTo: now - 3600,
				url: null,
			},
		])
		const alerts = t.app.get(AlertsService)
		// Skip the 5 min cache from the first request.
		alerts.now = () => Date.now() + 10 * 60_000
		const res = await t.json<Body<{ id: string; route_ids: string[]; severity: string }[]>>(
			"/v1/networks/kocaeli-ulasimpark/alerts",
		)
		expect(res.body.data).toHaveLength(1)
		expect(res.body.data[0]).toMatchObject({
			id: `${bindingId}.a1`,
			route_ids: [`${bindingId}.9001`],
			severity: "warning",
		})

		// A failing provider keeps serving the last answer.
		fake.setAlerts(bindingId, new ProviderError("upstream_error", "down"))
		alerts.now = () => Date.now() + 20 * 60_000
		const stale = await t.json<Body<unknown[]>>("/v1/networks/kocaeli-ulasimpark/alerts")
		expect(stale.body.data).toHaveLength(1)
	})
})
