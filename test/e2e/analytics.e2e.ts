import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DatabaseService } from "@db"
import { NetworksService } from "@services/networks/networks.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { accessTokenFor } from "../helpers/oauth-client"
import { buildFixture, insertFixture, POSITIONS_PER_DAY } from "../helpers/vts-fixtures"

let t: TestApp
let bindingId: number
const tokens: Record<string, string> = {}
const D1 = "2026-10-19"
const D2 = "2026-10-20"
const BASE = "/v1/dash/networks/kocaeli-ulasimpark/analytics"

type Body<T> = { ok: boolean; data: T; error: { code: string } }
interface Metric {
	columns: string[]
	rows: unknown[][]
	meta: { source: string; n: number; timezone: string; binding_ids: number[] }
}

async function api<T = unknown>(path: string, who?: string, init: RequestInit = {}) {
	return t.json<Body<T>>(path, {
		...init,
		headers: who ? { authorization: `Bearer ${tokens[who]}` } : {},
	})
}

beforeAll(async () => {
	t = await createTestApp()
	const networks = t.app.get(NetworksService)
	bindingId = networks.bindings(networks.network("kocaeli-ulasimpark").id)[0]!.id
	insertFixture(t.app.get(DatabaseService).vts.$client, bindingId, buildFixture([D1, D2]))
	for (const who of ["admin", "analyst", "rider"])
		tokens[who] = (await accessTokenFor(t, `${who}@test.gezcez.com`)).accessToken
}, 60_000)
afterAll(async () => {
	await t.close()
})

describe("dashboard analytics", () => {
	test("needs analytics.read in the network", async () => {
		expect((await api(`${BASE}/fleet.hourly`)).status).toBe(401)
		const rider = await api(`${BASE}/fleet.hourly`, "rider")
		expect(rider.status).toBe(403)
		expect(rider.body.error.code).toBe("PERMISSION_MISSING")
	})

	test("catalogue lists every metric", async () => {
		const res = await api<{ metrics: { key: string }[]; max_days: number }>(BASE, "analyst")
		expect(res.status).toBe(200)
		expect(res.body.data.metrics).toHaveLength(12)
		expect(res.body.data.max_days).toBe(90)
	})

	test("a metric as columnar JSON from hot data, cached for a day when closed", async () => {
		const res = await api<Metric>(
			`${BASE}/fleet.hourly?from=${D1}&to=${D2}&granularity=1d`,
			"analyst",
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("cache-control")).toBe("private, max-age=86400")
		expect(res.body.data.columns).toEqual([
			"bucket",
			"vehicles",
			"vehicle_hours",
			"peak_vehicles",
		])
		expect(res.body.data.rows).toEqual([
			[D1, 4, 1.5, 3],
			[D2, 4, 1.5, 3],
		])
		expect(res.body.data.meta).toMatchObject({
			source: "hot",
			n: 2,
			timezone: "Europe/Istanbul",
			binding_ids: [bindingId],
		})
	})

	test("filters and validation", async () => {
		const runs = await api<Metric>(
			`${BASE}/runs.departures?from=${D1}&to=${D1}&route_id=${bindingId}.R1&direction=0`,
			"analyst",
		)
		expect(runs.body.data.rows).toEqual([[D1, "R1", 0, 4]])
		expect((await api(`${BASE}/nope`, "analyst")).status).toBe(404)
		const bad = await api(`${BASE}/fleet.hourly?route_id=x';--`, "analyst")
		expect(bad.status).toBe(400)
		expect(bad.body.error.code).toBe("VALIDATION_FAILED")
		const long = await api(`${BASE}/fleet.hourly?from=2026-01-01&to=2026-10-01`, "analyst")
		expect(long.body.error.code).toBe("VALIDATION_FAILED")
		const marey = await api(`${BASE}/headways.marey?date=${D1}`, "analyst")
		expect(marey.body.error.code).toBe("VALIDATION_FAILED")
	})

	test("archive export by an admin, then metrics read the archive", async () => {
		expect(
			(await api(`/v1/dash/archive/${bindingId}/${D1}/export`, "analyst", { method: "POST" }))
				.status,
		).toBe(403)
		const run = await api<{ datasets: { dataset: string; rows: number; verified: boolean }[] }>(
			`/v1/dash/archive/${bindingId}/${D1}/export`,
			"admin",
			{ method: "POST" },
		)
		expect(run.status).toBe(200)
		expect(run.body.data.datasets.find((d) => d.dataset === "positions")).toMatchObject({
			rows: POSITIONS_PER_DAY,
			verified: true,
		})
		const today = new Date().toISOString().slice(0, 10)
		const partial = await api(`/v1/dash/archive/${bindingId}/${today}/export`, "admin", {
			method: "POST",
		})
		expect(partial.status).toBe(400)

		const status = await api<{
			uploader: string
			entries: { date: string; state: string }[]
		}>(`/v1/dash/archive?binding_id=${bindingId}`, "admin")
		expect(status.body.data.uploader).toBe("none")
		expect(status.body.data.entries.map((e) => [e.date, e.state])).toEqual([
			[D1, "verified"],
			[D1, "verified"],
			[D1, "verified"],
		])

		const metric = await api<Metric>(
			`${BASE}/runs.runtime?date=${D1}&hour_from=8&hour_to=8`,
			"analyst",
		)
		expect(metric.body.data.rows).toEqual([["R1", 0, 8, 4, 17, 17, 17]])
		const fleet = await api<Metric>(`${BASE}/fleet.hourly?date=${D1}`, "analyst")
		expect(fleet.body.data.meta.source).toBe("archive")
	})

	test("CSV and Parquet exports need analytics.export", async () => {
		const rider = await t.fetch(`${BASE}/runs.departures/export?from=${D1}&to=${D2}`, {
			headers: { authorization: `Bearer ${tokens.rider}` },
		})
		expect(rider.status).toBe(403)
		const csv = await t.fetch(`${BASE}/runs.departures/export?from=${D1}&to=${D2}`, {
			headers: { authorization: `Bearer ${tokens.analyst}` },
		})
		expect(csv.status).toBe(200)
		expect(csv.headers.get("content-type")).toStartWith("text/csv")
		expect(csv.headers.get("content-disposition")).toBe(
			`attachment; filename="runs.departures_${D1}_${D2}.csv"`,
		)
		expect((await csv.text()).trim().split("\n")).toEqual([
			"date,route_ext,direction,departures",
			`${D1},R1,0,4`,
			`${D1},R2,1,1`,
			`${D2},R1,0,4`,
			`${D2},R2,1,1`,
		])
		const parquet = await t.fetch(
			`${BASE}/quality.feed/export?from=${D1}&to=${D2}&format=parquet`,
			{ headers: { authorization: `Bearer ${tokens.analyst}` } },
		)
		expect(parquet.status).toBe(200)
		expect(parquet.headers.get("content-type")).toBe("application/vnd.apache.parquet")
		expect(
			Buffer.from(await parquet.arrayBuffer())
				.subarray(0, 4)
				.toString(),
		).toBe("PAR1")
	})
})
