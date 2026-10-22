import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestApp, type TestApp } from "../helpers/app"
import { accessTokenFor } from "../helpers/oauth-client"

let t: TestApp
const tokens: Record<string, string> = {}

type Body<T> = { ok: boolean; data: T; error: { code: string } }

async function api<T = unknown>(path: string, who?: string, init: RequestInit = {}) {
	return t.json<Body<T>>(path, {
		...init,
		headers: {
			...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
			...(init.body ? { "content-type": "application/json" } : {}),
		},
	})
}

beforeAll(async () => {
	t = await createTestApp()
	for (const who of ["root", "admin", "netadmin", "analyst", "rider"])
		tokens[who] = (await accessTokenFor(t, `${who}@test.gezcez.com`)).accessToken
})
afterAll(async () => {
	await t.close()
})

describe("dashboard catalog reads", () => {
	test("need a dash token and a permission", async () => {
		expect((await api("/v1/dash/providers")).status).toBe(401)
		const rider = await api("/v1/dash/providers", "rider")
		expect(rider.status).toBe(403)
		expect(rider.body.error.code).toBe("PERMISSION_MISSING")
	})

	test("providers carry config schema and credential health, never secrets", async () => {
		const list = await api<{ key: string; env_enabled: boolean; adapter: boolean }[]>(
			"/v1/dash/providers",
			"admin",
		)
		expect(list.status).toBe(200)
		expect(list.body.data.map((p) => p.key)).toEqual(["fake", "kentkart"])
		const kentkart = await api<{
			config_schema: { properties: Record<string, unknown> }
			credentials: unknown[]
		}>("/v1/dash/providers/kentkart", "admin")
		expect(Object.keys(kentkart.body.data.config_schema.properties)).toContain("api_url")
		const raw = JSON.stringify(kentkart.body)
		expect(raw).not.toMatch(/client_?secret"\s*:\s*"/i)
	})

	test("network list follows membership; network reads are scoped", async () => {
		const mine = await api<
			{ slug: string; bindings: { provider_key: string; state: string }[] }[]
		>("/v1/dash/networks", "netadmin")
		expect(mine.body.data.map((n) => n.slug)).toEqual(["kocaeli-ulasimpark"])
		expect(mine.body.data[0]!.bindings[0]!.provider_key).toBe("fake")
		const all = await api<{ slug: string }[]>("/v1/dash/networks", "admin")
		expect(all.body.data.map((n) => n.slug).sort()).toEqual([
			"kocaeli-ulasimpark",
			"test-network-b",
		])
		const analyst = await api("/v1/dash/networks/kocaeli-ulasimpark/bindings", "analyst")
		expect(analyst.status).toBe(200)
		const other = await api("/v1/dash/networks/test-network-b", "analyst")
		expect(other.status).toBe(403)
		const cities = await api<{ slug: string }[]>("/v1/dash/cities", "admin")
		expect(cities.body.data.map((c) => c.slug)).toContain("kocaeli")
	})

	test("a network admin can trigger a static sync and read the run history", async () => {
		const bindings = await api<{ id: number }[]>(
			"/v1/dash/networks/kocaeli-ulasimpark/bindings",
			"netadmin",
		)
		const id = bindings.body.data[0]!.id
		const run = await api<{ status: string; counts: { routes: number } }>(
			`/v1/dash/networks/kocaeli-ulasimpark/bindings/${id}/sync`,
			"netadmin",
			{ method: "POST" },
		)
		expect(run.status).toBe(200)
		expect(run.body.data.status).toBe("ok")
		expect(run.body.data.counts.routes).toBe(3)
		const denied = await api(
			`/v1/dash/networks/kocaeli-ulasimpark/bindings/${id}/sync`,
			"analyst",
			{
				method: "POST",
			},
		)
		expect(denied.status).toBe(403)
		const runs = await api<{ items: { status: string; trigger: string }[] }>(
			"/v1/dash/networks/kocaeli-ulasimpark/sync-runs",
			"analyst",
		)
		expect(runs.body.data.items[0]).toMatchObject({ status: "ok", trigger: "manual" })
	})
})

describe("provider kill switch", () => {
	test("admin lacks providers.kill; root kills with a reason and the manifest follows", async () => {
		const admin = await api("/v1/dash/providers/fake/kill", "admin", {
			method: "POST",
			body: JSON.stringify({ enabled: false, reason: "legal hold" }),
		})
		expect(admin.status).toBe(403)

		const kill = await api<{ enabled: boolean; disabled_reason: string }>(
			"/v1/dash/providers/fake/kill",
			"root",
			{ method: "POST", body: JSON.stringify({ enabled: false, reason: "legal hold" }) },
		)
		expect(kill.status).toBe(200)
		expect(kill.body.data).toMatchObject({ enabled: false, disabled_reason: "legal hold" })
		const manifest = await api<{
			networks: {
				slug: string
				status: string
				capabilities: { realtime_vehicles: boolean }
			}[]
		}>("/v1/cities/kocaeli/manifest")
		const network = manifest.body.data.networks.find((n) => n.slug === "kocaeli-ulasimpark")!
		expect(network.status).toBe("disabled")
		expect(network.capabilities.realtime_vehicles).toBe(false)

		await api("/v1/dash/providers/fake/kill", "root", {
			method: "POST",
			body: JSON.stringify({ enabled: true, reason: "cleared" }),
		})
		const after = await api<{ networks: { slug: string; status: string }[] }>(
			"/v1/cities/kocaeli/manifest",
		)
		expect(after.body.data.networks.find((n) => n.slug === "kocaeli-ulasimpark")!.status).toBe(
			"active",
		)
	})
})
