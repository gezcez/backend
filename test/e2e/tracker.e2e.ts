import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { localTime, serviceDayStart } from "@common/utils"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import type { RawVehicle, VehicleFeed } from "@services/providers/transit-provider.interface"
import { LiveFeedBus } from "@services/tracker/live-feed.bus"
import { TrackerHostService } from "@services/tracker/tracker-host.service"
import { TrackerRepository } from "@services/tracker/tracker.repository"
import type { TrackerService } from "@services/tracker/tracker.service"
import { TransitSyncService } from "@services/transit/transit-sync.service"
import { createTestApp, type TestApp } from "../helpers/app"

const TZ = "Europe/Istanbul"
const dirs: string[] = []

afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

function dataDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-tracker-"))
	dirs.push(dir)
	return dir
}

interface Harness {
	t: TestApp
	engine: TrackerService
	bindingId: number
	script(feeds: VehicleFeed[]): void
	repository: TrackerRepository
	bus: LiveFeedBus
}

async function boot(dir: string): Promise<Harness> {
	const t = await createTestApp({ TRACKER_RUNNER: "manual", DATA_DIR: dir })
	const networks = t.app.get(NetworksService)
	const network = networks.network("kocaeli-ulasimpark")
	const bindingId = networks.bindings(network.id)[0]!.id
	const engine = t.app.get(TrackerHostService).inlineEngine()!
	const fake = t.app.get(ProvidersRegistry).fake
	return {
		t,
		engine,
		bindingId,
		script: (feeds) => fake.script(bindingId, feeds),
		repository: t.app.get(TrackerRepository),
		bus: t.app.get(LiveFeedBus),
	}
}

function vehicle(id: string, ts: number, extra: Partial<RawVehicle> = {}): RawVehicle {
	return {
		externalId: id,
		plate: `41 T ${id}`,
		lat: 40.7654,
		lon: 29.9408,
		routeExt: "9001",
		direction: 0,
		tripExt: "X1",
		stopSeq: 1,
		vehicleTs: ts,
		...extra,
	}
}

function feed(feedTs: number, entities: RawVehicle[]): VehicleFeed {
	return { feedTs, entities, urlVariant: "primary", bytes: 100, invalid: 0 }
}

describe("tracker engine with the fake provider", () => {
	test("runs: open with timetable match, dedup, trip change, disappearance", async () => {
		const h = await boot(dataDir())
		try {
			await h.t.app.get(TransitSyncService).sync(h.bindingId, "manual")
			// Noon today, so the synthetic 15 min timetable has a trip at 12:00.
			const noon = serviceDayStart(Math.floor(Date.now() / 1000), TZ) + 12 * 3600
			const weekday = localTime(noon, TZ).weekday
			const service = weekday < 5 ? "1" : weekday === 5 ? "2" : "3"
			const tripAtNoon = `90010${service}0720`
			h.script([
				feed(noon + 125, [
					vehicle("A", noon + 120, { tripExt: tripAtNoon }),
					vehicle("S", noon + 120, { label: "GÖREVLİ" }),
					vehicle("B", noon + 110, { tripExt: "0", routeExt: "9002" }),
				]),
				feed(noon + 125, [vehicle("A", noon + 120, { tripExt: tripAtNoon })]),
				feed(noon + 155, [
					vehicle("A", noon + 150, { tripExt: tripAtNoon, stopSeq: 3 }),
					vehicle("B", noon + 150, { tripExt: "0", routeExt: "9002" }),
				]),
				feed(noon + 185, [
					vehicle("A", noon + 180, { tripExt: "OTHER", stopSeq: 1 }),
					vehicle("B", noon + 180, { tripExt: "0", routeExt: "9002" }),
				]),
				feed(noon + 215, [vehicle("B", noon + 210, { tripExt: "0", routeExt: "9002" })]),
				feed(noon + 245, [vehicle("B", noon + 240, { tripExt: "0", routeExt: "9002" })]),
				feed(noon + 400, [vehicle("B", noon + 395, { tripExt: "0", routeExt: "9002" })]),
			])

			const first = await h.engine.pollOnce(h.bindingId)
			expect(first).toMatchObject({ outcome: "ok", accepted: 2, inserted: 2, opened: 2 })
			expect(
				h.bus
					.vehicles(h.bindingId)
					.map((v) => v.external_id)
					.sort(),
			).toEqual(["A", "B"])
			const polls = h.repository.polls(h.bindingId, 1, 0)
			expect(polls[0]!.dropped).toMatchObject({ staff: 1 })

			expect((await h.engine.pollOnce(h.bindingId)).outcome).toBe("duplicate_header")
			expect(await h.engine.pollOnce(h.bindingId)).toMatchObject({
				outcome: "ok",
				inserted: 2,
			})
			expect(await h.engine.pollOnce(h.bindingId)).toMatchObject({ opened: 1, closed: 1 })

			const a = h.repository.vehicle(h.bindingId, "A")!
			const runs = h.repository.runsOfVehicle(a.id, 0)
			const done = runs.find((r) => r.trip_ext === tripAtNoon)!
			expect(done).toMatchObject({
				started_at: noon + 120,
				ended_at: noon + 150,
				end_reason: "trip_change",
				samples: 2,
				max_stop_seq: 3,
				scheduled_start_s: 43200,
				start_delay_s: 120,
			})
			const b = h.repository.vehicle(h.bindingId, "B")!
			expect(h.repository.runsOfVehicle(b.id, 0)[0]).toMatchObject({
				keyed_by_route: true,
				scheduled_start_s: null,
			})

			// A is missing from three feeds; the third is 215 s after it was last seen.
			await h.engine.pollOnce(h.bindingId)
			await h.engine.pollOnce(h.bindingId)
			expect(
				h.bus
					.vehicles(h.bindingId)
					.map((v) => v.external_id)
					.sort(),
			).toEqual(["A", "B"])
			await h.engine.pollOnce(h.bindingId)
			expect(h.bus.vehicles(h.bindingId).map((v) => v.external_id)).toEqual(["B"])
			const other = h.repository.runsOfVehicle(a.id, 0).find((r) => r.trip_ext === "OTHER")!
			expect(other).toMatchObject({ end_reason: "disappeared", ended_at: noon + 180 })
		} finally {
			await h.t.close()
		}
	})

	test("upstream failures go degraded, and the kill switch closes runs", async () => {
		const h = await boot(dataDir())
		try {
			const now = Math.floor(Date.now() / 1000)
			const { ProviderError } = await import("@services/providers/transit-provider.interface")
			h.script([
				feed(now, [vehicle("K", now)]),
				new ProviderError("upstream_error", "boom", { httpStatus: 502 }),
				new ProviderError("timeout", "slow"),
				new ProviderError("decode_error", "bad"),
			] as never)
			await h.engine.pollOnce(h.bindingId)
			for (let i = 0; i < 3; i++) await h.engine.pollOnce(h.bindingId)
			const status = h.engine.statuses().find((s) => s.binding_id === h.bindingId)!
			expect(status).toMatchObject({ state: "degraded", consecutive_failures: 3 })
			expect(h.repository.polls(h.bindingId, 3, 0).map((p) => p.outcome)).toEqual([
				"decode_error",
				"timeout",
				"upstream_error",
			])

			const networks = h.t.app.get(NetworksService)
			networks.setProviderEnabled("fake", false, "legal hold", null)
			// The catalog change reaches the tracker through the host's reload.
			await Bun.sleep(10)
			const killed = h.engine.statuses().find((s) => s.binding_id === h.bindingId)!
			expect(killed).toMatchObject({ state: "killed", message: "legal hold" })
			expect(h.bus.vehicles(h.bindingId)).toEqual([])
			const k = h.repository.vehicle(h.bindingId, "K")!
			expect(h.repository.runsOfVehicle(k.id, 0)[0]).toMatchObject({ end_reason: "killed" })
			expect((await h.engine.pollOnce(h.bindingId)).outcome).toBe("skipped_killed")

			networks.setProviderEnabled("fake", true, "cleared", null)
			await Bun.sleep(10)
			expect(h.engine.statuses().find((s) => s.binding_id === h.bindingId)!.state).not.toBe(
				"killed",
			)
		} finally {
			await h.t.close()
		}
	})

	test("restart: a short gap continues runs, a long gap closes them with gap", async () => {
		const dir = dataDir()
		const now = Math.floor(Date.now() / 1000)
		let h = await boot(dir)
		h.script([feed(now - 1000, [vehicle("OLD", now - 1000)])])
		await h.engine.pollOnce(h.bindingId)
		await h.t.close()

		h = await boot(dir)
		const old = h.repository.vehicle(h.bindingId, "OLD")!
		expect(h.repository.runsOfVehicle(old.id, 0)[0]).toMatchObject({
			end_reason: "gap",
			ended_at: now - 1000,
		})
		expect(h.bus.vehicles(h.bindingId)).toEqual([])
		h.script([feed(now - 30, [vehicle("NEW", now - 30)])])
		await h.engine.pollOnce(h.bindingId)
		await h.t.close()

		h = await boot(dir)
		try {
			expect(h.bus.vehicles(h.bindingId).map((v) => v.external_id)).toEqual(["NEW"])
			h.script([feed(now, [vehicle("NEW", now, { stopSeq: 2 })])])
			expect(await h.engine.pollOnce(h.bindingId)).toMatchObject({ opened: 0, closed: 0 })
			const fresh = h.repository.vehicle(h.bindingId, "NEW")!
			const runs = h.repository.runsOfVehicle(fresh.id, 0)
			expect(runs).toHaveLength(1)
			expect(runs[0]).toMatchObject({ ended_at: null, samples: 2, last_stop_seq: 2 })
		} finally {
			await h.t.close()
		}
	})

	test("retention keeps unarchived days unless the archive guard is off", async () => {
		const dir = dataDir()
		const now = Math.floor(Date.now() / 1000)
		const old = now - 10 * 86400
		let h = await boot(dir)
		h.script([feed(old, [vehicle("R", old)]), feed(now - 20, [vehicle("R", now - 20)])])
		await h.engine.pollOnce(h.bindingId)
		await h.engine.pollOnce(h.bindingId)
		expect(h.repository.positionCount(h.bindingId)).toBe(2)
		expect(h.engine.runRetention(now).positions).toBe(0)
		expect(h.repository.positionCount(h.bindingId)).toBe(2)
		await h.t.close()

		const t = await createTestApp({
			TRACKER_RUNNER: "manual",
			DATA_DIR: dir,
			VTS_RETENTION_REQUIRE_ARCHIVE: "false",
		})
		try {
			const engine = t.app.get(TrackerHostService).inlineEngine()!
			expect(engine.runRetention(now).positions).toBe(1)
			expect(t.app.get(TrackerRepository).positionCount(h.bindingId)).toBe(1)
		} finally {
			await t.close()
		}
	})
})
