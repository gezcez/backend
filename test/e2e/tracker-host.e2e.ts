import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { serviceDayStart } from "@common/utils"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import {
	ProviderError,
	type RawVehicle,
	type VehicleFeed,
} from "@services/providers/transit-provider.interface"
import { LiveFeedBus } from "@services/tracker/live-feed.bus"
import { TrackerHostService, type TrackerLogLine } from "@services/tracker/tracker-host.service"
import { TrackerTimetable } from "@services/tracker/tracker-timetable"
import { TrackerRepository } from "@services/tracker/tracker.repository"
import { TrackerService } from "@services/tracker/tracker.service"
import { createTestApp, type TestApp } from "../helpers/app"

// The tracker host's runners other than the worker: MODE=api following vehicle_state, the
// inline runner with real timers, and the engine's control and retention edge cases.

const TZ = "Europe/Istanbul"
const dirs: string[] = []

afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

function dataDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-tracker-host-"))
	dirs.push(dir)
	return dir
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

function bindingOf(t: TestApp): number {
	const networks = t.app.get(NetworksService)
	return networks.bindings(networks.network("kocaeli-ulasimpark").id)[0]!.id
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
	const until = Date.now() + ms
	while (!check()) {
		if (Date.now() > until) throw new Error("timed out waiting")
		await Bun.sleep(20)
	}
}

/** followChanges runs every 2 s; tests call it directly so they do not wait for the timer. */
function follow(host: TrackerHostService): void {
	;(host as unknown as { followChanges(): void }).followChanges()
}

describe("MODE=api change feed", () => {
	test("follows polls and vehicle_state written by the tracker process", async () => {
		const dir = dataDir()
		const tracker = await createTestApp({ TRACKER_RUNNER: "manual", DATA_DIR: dir })
		const api = await createTestApp({ MODE: "api", DATA_DIR: dir })
		try {
			const bindingId = bindingOf(tracker)
			const engine = tracker.app.get(TrackerHostService).inlineEngine()!
			const fake = tracker.app.get(ProvidersRegistry).fake
			const host = api.app.get(TrackerHostService)
			const bus = api.app.get(LiveFeedBus)

			expect(host.runner).toBe("external")
			expect(host.isRunning()).toBe(true)
			expect(host.inlineEngine()).toBeUndefined()
			expect(await host.control({ type: "poll-now", binding_id: bindingId })).toEqual({
				ok: false,
				error: "The tracker runs in another process (MODE=api)",
			})
			const ready = await api.json<{ checks: { name: string; ok: boolean }[] }>("/ready")
			expect(ready.body.checks).toContainEqual({ name: "tracker", ok: true })

			// Nothing new yet: no statuses.
			follow(host)
			expect(host.status(bindingId)).toBeUndefined()

			const now = Math.floor(Date.now() / 1000)
			fake.script(bindingId, [
				feed(now, [vehicle("A", now), vehicle("B", now - 5)]),
				new ProviderError("upstream_error", "boom", { httpStatus: 502 }),
				new ProviderError("timeout", "slow"),
				new ProviderError("decode_error", "bad"),
			] as never)
			expect((await engine.pollOnce(bindingId)).outcome).toBe("ok")

			const sets = engine.liveSets().find((set) => set.binding_id === bindingId)!
			expect(sets.reset).toBe(true)
			expect(sets.upsert.map((v) => v.external_id).sort()).toEqual(["A", "B"])

			follow(host)
			expect(
				bus
					.vehicles(bindingId)
					.map((v) => v.external_id)
					.sort(),
			).toEqual(["A", "B"])
			expect(bus.lastFeedTs(bindingId)).toBe(now)
			expect(host.status(bindingId)).toMatchObject({
				state: "ok",
				last_outcome: "ok",
				last_feed_ts: now,
				consecutive_failures: 0,
				live_vehicles: 2,
				url_variant: "primary",
			})
			expect(host.statuses()).toHaveLength(1)

			// Three failures in a row: the third goes degraded, the feed time is kept.
			for (let i = 0; i < 3; i++) await engine.pollOnce(bindingId)
			const changes: string[] = []
			const off = host.onStatusChange((status) => changes.push(status.state))
			follow(host)
			off()
			expect(host.status(bindingId)).toMatchObject({
				state: "degraded",
				last_outcome: "decode_error",
				last_feed_ts: now,
				consecutive_failures: 3,
			})
			// Listeners hear every state or message change: two new errors, then degraded.
			expect(changes).toEqual(["ok", "ok", "degraded"])

			// The kill switch in the tracker process shows up as killed.
			tracker.app.get(NetworksService).setProviderEnabled("fake", false, "legal hold", null)
			await Bun.sleep(10)
			expect((await engine.pollOnce(bindingId)).outcome).toBe("skipped_killed")
			follow(host)
			expect(host.status(bindingId)!.state).toBe("killed")

			// A broken read is logged and retried on the next tick, not thrown.
			const repository = api.app.get(TrackerRepository)
			const original = repository.pollsAfter.bind(repository)
			repository.pollsAfter = () => {
				throw new Error("database is locked")
			}
			expect(() => follow(host)).not.toThrow()
			repository.pollsAfter = original
		} finally {
			await api.app.close()
			await tracker.close()
		}
	})
})

describe("inline runner", () => {
	test("pause, resume, poll now and the other controls with real timers", async () => {
		const t = await createTestApp({ TRACKER_RUNNER: "inline" })
		try {
			const bindingId = bindingOf(t)
			const host = t.app.get(TrackerHostService)
			const repository = t.app.get(TrackerRepository)
			const fake = t.app.get(ProvidersRegistry).fake
			const engine = host.inlineEngine()!
			expect(host.runner).toBe("inline")
			expect(host.isRunning()).toBe(true)
			const logs: TrackerLogLine[] = []
			const offLogs = host.onLogLine((line) => logs.push(line))

			const paused = await host.control({ type: "pause", binding_id: bindingId })
			expect(paused).toMatchObject({ ok: true, status: { state: "paused", next_poll_at: null } })
			expect(host.status(bindingId)!.state).toBe("paused")
			// Pausing twice is a no-op.
			expect((await host.control({ type: "pause", binding_id: bindingId })).ok).toBe(true)
			expect(logs.filter((l) => l.message.endsWith("paused"))).toHaveLength(1)

			const now = Math.floor(Date.now() / 1000)
			fake.script(bindingId, [
				feed(now, [vehicle("R", now)]),
				new ProviderError("upstream_error", "boom", { httpStatus: 502 }),
				feed(now + 30, [vehicle("R", now + 30)]),
			] as never)
			const before = repository.polls(bindingId, 50, 0).length
			// Resume polls at once through the scheduler.
			expect((await host.control({ type: "resume", binding_id: bindingId })).ok).toBe(true)
			await waitFor(() => repository.polls(bindingId, 50, 0).length > before)
			expect(repository.polls(bindingId, 1, 0)[0]!.outcome).toBe("ok")
			await waitFor(() => host.status(bindingId)!.next_poll_at !== null)
			const status = host.status(bindingId)!
			expect(status.state).toBe("ok")
			expect(status.interval_s).toBeGreaterThan(0)
			expect(status.next_poll_at!).toBeGreaterThan(now)
			// Resuming a running binding is a no-op.
			expect((await host.control({ type: "resume", binding_id: bindingId })).ok).toBe(true)

			// A failed poll-now reports the outcome and reschedules.
			const failed = await host.control({ type: "poll-now", binding_id: bindingId })
			expect(failed).toMatchObject({ ok: false, error: "upstream_error" })
			const ok = await host.control({ type: "poll-now", binding_id: bindingId })
			expect(ok).toMatchObject({ ok: true, error: "ok" })
			expect(ok.status!.next_poll_at).not.toBeNull()

			expect(await host.control({ type: "pause", binding_id: 999_999 })).toEqual({
				ok: false,
				error: "Binding is not tracked",
			})
			expect(await host.control({ type: "pause" })).toEqual({
				ok: false,
				error: "Binding is not tracked",
			})
			expect((await host.control({ type: "reset-url", binding_id: bindingId })).ok).toBe(true)
			expect(await host.control({ type: "refresh-token", binding_id: bindingId })).toEqual({
				ok: false,
				error: "Provider has no credentials",
			})
			expect(await host.control({ type: "reload-bindings" })).toEqual({ ok: true })

			// A poll that crashes is logged and the binding keeps its schedule.
			const pollOnce = engine.pollOnce.bind(engine)
			engine.pollOnce = () => Promise.reject(new Error("disk full"))
			await host.control({ type: "pause", binding_id: bindingId })
			await host.control({ type: "resume", binding_id: bindingId })
			await waitFor(() => logs.some((l) => l.message.includes("poll crashed: disk full")))
			engine.pollOnce = pollOnce
			await waitFor(() => host.status(bindingId)!.next_poll_at !== null)
			expect(host.recentLogs(bindingId).some((l) => l.level === "error")).toBe(true)
			expect(host.recentLogs(999_999)).toEqual([])
			expect(host.recentLogs().length).toBeGreaterThanOrEqual(host.recentLogs(bindingId).length)
			offLogs()

			host.setSubscribers({ [bindingId]: 2 })
			expect(host.status(bindingId)!.subscribers).toBe(2)
			host.touch(bindingId)
			host.setSubscribers({})
			expect(host.status(bindingId)!.subscribers).toBe(0)
		} finally {
			await t.close()
		}
	})
})

describe("tracker engine edge cases", () => {
	test("retention runs at 05:00 Istanbul, logs failures and reschedules itself", async () => {
		const t = await createTestApp({ TRACKER_RUNNER: "manual" })
		const config = t.config
		const engine = new TrackerService(
			config,
			t.app.get(TrackerRepository),
			t.app.get(NetworksService),
			t.app.get(ProvidersRegistry),
			t.app.get(TrackerTimetable),
		)
		try {
			// One second before the retention time, frozen.
			const at = serviceDayStart(Math.floor(Date.now() / 1000), TZ) + 5 * 3600 - 1
			engine.now = () => at * 1000
			const logs: string[] = []
			engine.onLog((_binding, level, message) => logs.push(`${level}: ${message}`))
			let runs = 0
			const runRetention = engine.runRetention.bind(engine)
			engine.runRetention = (nowS?: number) => {
				runs++
				if (runs === 2) throw new Error("disk I/O error")
				return runRetention(nowS)
			}
			// Pause every binding so only the retention timer runs.
			engine.start({ schedule: true })
			for (const status of engine.statuses())
				await engine.control({ type: "pause", binding_id: status.binding_id })
			await waitFor(() => runs >= 2, 4000)
			expect(logs).toContain("error: retention failed: disk I/O error")
			expect(logs.some((line) => line.includes("tracker started with"))).toBe(true)
		} finally {
			await engine.stop()
			await t.close()
		}
	})

	test("poll-now on a killed binding is refused with the kill reason", async () => {
		const t = await createTestApp({ TRACKER_RUNNER: "manual" })
		try {
			const bindingId = bindingOf(t)
			const host = t.app.get(TrackerHostService)
			t.app.get(NetworksService).setProviderEnabled("fake", false, "legal hold", null)
			await Bun.sleep(10)
			const result = await host.control({ type: "poll-now", binding_id: bindingId })
			expect(result).toMatchObject({
				ok: false,
				error: "legal hold",
				status: { state: "killed" },
			})
			// The timetable cache can be dropped per binding or entirely.
			const timetable = t.app.get(TrackerTimetable)
			timetable.invalidate(bindingId)
			timetable.invalidate()
		} finally {
			await t.close()
		}
	})
})
