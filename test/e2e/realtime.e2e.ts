import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import type { RawVehicle, VehicleFeed } from "@services/providers/transit-provider.interface"
import { TrackerHostService } from "@services/tracker/tracker-host.service"
import type { TrackerService } from "@services/tracker/tracker.service"
import { TransitSyncService } from "@services/transit/transit-sync.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { accessTokenFor } from "../helpers/oauth-client"

let t: TestApp
let engine: TrackerService
let bindingId: number
let netadmin: string
let analyst: string
const now = Math.floor(Date.now() / 1000)

type Msg = Record<string, unknown> & { type: string }

class TestSocket {
	readonly messages: Msg[] = []
	private waiters: (() => void)[] = []
	closeCode: number | null = null
	readonly opened: Promise<void>
	readonly closed: Promise<number>
	readonly ws: WebSocket

	constructor(url: string) {
		this.ws = new WebSocket(url)
		this.opened = new Promise((resolve) => this.ws.addEventListener("open", () => resolve()))
		this.closed = new Promise((resolve) =>
			this.ws.addEventListener("close", (event) => {
				this.closeCode = event.code
				resolve(event.code)
				this.wake()
			}),
		)
		this.ws.addEventListener("message", (event) => {
			this.messages.push(JSON.parse(String(event.data)) as Msg)
			this.wake()
		})
	}

	private wake() {
		const waiters = this.waiters
		this.waiters = []
		for (const w of waiters) w()
	}

	send(message: unknown) {
		this.ws.send(typeof message === "string" ? message : JSON.stringify(message))
	}

	/** The first message (from `from` on) matching `predicate`. */
	async next(predicate: (m: Msg) => boolean, from = 0, timeoutMs = 3000): Promise<Msg> {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			const found = this.messages.slice(from).find(predicate)
			if (found) return found
			if (this.closeCode !== null) throw new Error(`socket closed ${this.closeCode}`)
			const left = deadline - Date.now()
			if (left <= 0) throw new Error(`timeout; got ${JSON.stringify(this.messages)}`)
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, left)
				this.waiters.push(() => {
					clearTimeout(timer)
					resolve()
				})
			})
		}
	}

	close() {
		this.ws.close()
	}
}

function connect(): TestSocket {
	return new TestSocket(`${t.url.replace("http", "ws")}/v1/ws`)
}

function vehicle(id: string, extra: Partial<RawVehicle> = {}): RawVehicle {
	return {
		externalId: id,
		plate: `41 W ${id}`,
		label: "F1 Kuzey",
		lat: 40.7654,
		lon: 29.9408,
		routeExt: "9001",
		direction: 0,
		tripExt: "W1",
		stopSeq: 2,
		status: 2,
		vehicleTs: now - 5,
		...extra,
	}
}

function feed(feedTs: number, entities: RawVehicle[]): VehicleFeed {
	return { feedTs, entities, urlVariant: "primary", bytes: 0, invalid: 0 }
}

async function poll(feeds: VehicleFeed[]) {
	t.app.get(ProvidersRegistry).fake.script(bindingId, feeds)
	for (let i = 0; i < feeds.length; i++) await engine.pollOnce(bindingId)
}

beforeAll(async () => {
	t = await createTestApp({ TRACKER_RUNNER: "manual" })
	const networks = t.app.get(NetworksService)
	bindingId = networks.bindings(networks.network("kocaeli-ulasimpark").id)[0]!.id
	await t.app.get(TransitSyncService).sync(bindingId, "manual")
	engine = t.app.get(TrackerHostService).inlineEngine()!
	await poll([feed(now, [vehicle("W1"), vehicle("W2", { lat: 40.95, routeExt: "9002" })])])
	netadmin = (await accessTokenFor(t, "netadmin@test.gezcez.com")).accessToken
	analyst = (await accessTokenFor(t, "analyst@test.gezcez.com")).accessToken
})
afterAll(async () => {
	await t.close()
})

describe("realtime gateway", () => {
	test("hello, ping/pong and a compact snapshot followed by deltas", async () => {
		const s = connect()
		const hello = await s.next((m) => m.type === "hello")
		expect(hello).toEqual({
			type: "hello",
			v: 1,
			heartbeat_s: 20,
			limits: { max_subs: 8, max_routes_per_sub: 12, max_bbox_span_deg: 0.5 },
		})
		s.send({ type: "ping", t: 7 })
		expect(await s.next((m) => m.type === "pong")).toEqual({ type: "pong", t: 7 })

		s.send({
			type: "subscribe",
			id: "map",
			channel: "vehicles",
			params: { network: "kocaeli-ulasimpark", bbox: [29.9, 40.7, 30.0, 40.8] },
		})
		const snap = await s.next((m) => m.type === "snapshot")
		expect(snap).toMatchObject({ sub: "map", seq: 1, feed_ts: now })
		expect((snap.vehicles as unknown[][]).map((v) => v[0])).toEqual([`${bindingId}.W1`])
		expect((snap.fields as string[]).includes("plate")).toBe(false)

		// The tracker hears that someone is watching.
		expect(engine.statuses().find((x) => x.binding_id === bindingId)!.subscribers).toBe(1)

		const at = s.messages.length
		await poll([
			feed(now + 30, [
				vehicle("W1", { vehicleTs: now + 25, stopSeq: 3 }),
				// W2 moves into the box; W3 appears outside it.
				vehicle("W2", { vehicleTs: now + 25, routeExt: "9002" }),
				vehicle("W3", { vehicleTs: now + 25, lat: 41.1 }),
			]),
		])
		const delta = await s.next((m) => m.type === "delta", at)
		expect(delta).toMatchObject({ sub: "map", seq: 2, feed_ts: now + 30, remove: [] })
		expect((delta.upsert as unknown[][]).map((v) => v[0]).sort()).toEqual([
			`${bindingId}.W1`,
			`${bindingId}.W2`,
		])

		const before = s.messages.length
		await poll([feed(now + 60, [vehicle("W1", { vehicleTs: now + 55, lat: 40.95 })])])
		const left = await s.next((m) => m.type === "delta", before)
		expect(left).toMatchObject({ seq: 3, upsert: [], remove: [`${bindingId}.W1`] })

		s.send({ type: "unsubscribe", id: "map" })
		await Bun.sleep(20)
		expect(engine.statuses().find((x) => x.binding_id === bindingId)!.subscribers).toBe(0)
		s.close()
	})

	test("full detail needs auth with vehicles.live.read; staff channels too", async () => {
		const s = connect()
		await s.next((m) => m.type === "hello")
		s.send({
			type: "subscribe",
			id: "full",
			channel: "vehicles",
			params: { network: "kocaeli-ulasimpark", detail: "full" },
		})
		expect(await s.next((m) => m.type === "error")).toMatchObject({
			id: "full",
			code: "AUTH_REQUIRED",
		})
		s.send({ type: "auth", token: netadmin })
		const ok = await s.next((m) => m.type === "auth_ok")
		expect(typeof ok.exp).toBe("number")
		s.send({
			type: "subscribe",
			id: "full",
			channel: "vehicles",
			params: { network: "kocaeli-ulasimpark", detail: "full" },
		})
		const snap = await s.next((m) => m.type === "snapshot")
		expect(snap.fields).toContain("plate")
		const row = (snap.vehicles as unknown[][]).find((v) => v[0] === `${bindingId}.W2`)!
		expect(row.slice(12)).toEqual(["41 W W2", null, "F1 Kuzey"])

		s.send({ type: "subscribe", id: "all", channel: "tracker.status", params: {} })
		// tracker.read is network scoped for a network admin: global status is refused.
		expect(await s.next((m) => m.type === "error" && m.id === "all")).toMatchObject({
			code: "PERMISSION_MISSING",
		})
		s.send({
			type: "subscribe",
			id: "ts",
			channel: "tracker.status",
			params: { network: "kocaeli-ulasimpark" },
		})
		const event = await s.next((m) => m.type === "event" && m.sub === "ts")
		expect(event.data).toMatchObject({ kind: "snapshot" })
		s.close()

		const a = connect()
		await a.next((m) => m.type === "hello")
		a.send({ type: "auth", token: analyst })
		await a.next((m) => m.type === "auth_ok")
		a.send({
			type: "subscribe",
			id: "other",
			channel: "vehicles",
			params: { network: "test-network-b", detail: "full" },
		})
		const denied = await a.next((m) => m.type === "error")
		expect(["PERMISSION_MISSING", "NOT_FOUND"]).toContain(denied.code as string)
		a.close()
	})

	test("departures channel sends the merged list", async () => {
		const s = connect()
		await s.next((m) => m.type === "hello")
		s.send({
			type: "subscribe",
			id: "dep",
			channel: "departures",
			params: { stop: `${bindingId}.900104`, limit: 5 },
		})
		const dep = await s.next((m) => m.type === "departures")
		expect(dep).toMatchObject({ sub: "dep", seq: 1, stop: `${bindingId}.900104` })
		expect(Array.isArray(dep.items)).toBe(true)
		s.send({ type: "subscribe", id: "bad", channel: "departures", params: { stop: "nope" } })
		expect(await s.next((m) => m.type === "error" && m.id === "bad")).toMatchObject({
			code: "NOT_FOUND",
		})
		s.close()
	})

	test("validation errors keep the socket; malformed and bad auth close it", async () => {
		const s = connect()
		await s.next((m) => m.type === "hello")
		s.send({
			type: "subscribe",
			id: "wide",
			channel: "vehicles",
			params: { network: "kocaeli-ulasimpark", bbox: [29, 40, 30, 41] },
		})
		expect(await s.next((m) => m.type === "error")).toMatchObject({
			id: "wide",
			code: "VALIDATION_FAILED",
		})
		s.send("not json")
		expect(await s.closed).toBe(4400)

		const b = connect()
		await b.next((m) => m.type === "hello")
		b.send({ type: "auth", token: "garbage" })
		expect(await b.closed).toBe(4401)
	})

	test("message rate limit answers RATE_LIMITED, then closes with 4429", async () => {
		const s = connect()
		await s.next((m) => m.type === "hello")
		for (let i = 0; i < 40; i++) s.send({ type: "ping", t: i })
		expect(await s.next((m) => m.type === "error")).toMatchObject({ code: "RATE_LIMITED" })
		expect(await s.closed).toBe(4429)
	})

	test("kill switch: subscribers get a killed status and an empty snapshot", async () => {
		const s = connect()
		await s.next((m) => m.type === "hello")
		s.send({
			type: "subscribe",
			id: "all",
			channel: "vehicles",
			params: { network: "kocaeli-ulasimpark" },
		})
		await s.next((m) => m.type === "snapshot")
		const at = s.messages.length
		t.app.get(NetworksService).setProviderEnabled("fake", false, "legal hold", null)
		const status = await s.next((m) => m.type === "status", at)
		expect(status).toMatchObject({ sub: "all", state: "killed", binding: bindingId })
		const snap = await s.next((m) => m.type === "snapshot", at)
		expect(snap.vehicles).toEqual([])
		t.app.get(NetworksService).setProviderEnabled("fake", true, "cleared", null)
		s.close()
	})

	test("the upgrade path is exact and the protocol is in openapi.json", async () => {
		const res = await t.json<{ components: { schemas: Record<string, unknown> } }>(
			"/openapi.json",
		)
		expect(res.body.components.schemas).toHaveProperty("WsServerMessage")
		expect(res.body.components.schemas).toHaveProperty("WsClientMessage")
		const wrong = new TestSocket(`${t.url.replace("http", "ws")}/v1/wsx`)
		const code = await wrong.closed
		expect(code).not.toBe(1000)
	})
})
