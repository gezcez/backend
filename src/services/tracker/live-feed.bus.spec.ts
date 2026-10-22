import { describe, expect, test } from "bun:test"
import { LiveFeedBus } from "./live-feed.bus"
import type { TrackerRepository } from "./tracker.repository"
import type { LiveVehicle } from "./tracker.types"

type StateRow = ReturnType<TrackerRepository["liveVehicles"]>[number]

function live(vehicleId: number, partial: Partial<LiveVehicle> = {}): LiveVehicle {
	return {
		vehicle_id: vehicleId,
		binding_id: 1,
		external_id: `ext-${vehicleId}`,
		plate: null,
		label: null,
		lat_e6: 40_760_000,
		lon_e6: 29_940_000,
		bearing_d10: null,
		speed_cms: null,
		route_ext: "41C",
		direction: 0,
		trip_ext: null,
		stop_ext: null,
		stop_seq: null,
		status: null,
		vehicle_ts: 1000,
		feed_ts: 1010,
		quality: 0,
		...partial,
	}
}

function bus(rows: Partial<StateRow>[] = []) {
	const repository = {
		liveVehicles: () => rows as StateRow[],
	} as unknown as TrackerRepository
	return new LiveFeedBus(repository)
}

describe("LiveFeedBus", () => {
	test("boots from live vehicle_state rows with the newest feed time per binding", () => {
		const b = bus([
			{ ...live(1), feed_ts: 100 },
			{ ...live(2), feed_ts: 300 },
			{ ...live(3, { binding_id: 2 }), feed_ts: 50 },
		])
		b.onApplicationBootstrap()
		expect(b.count(1)).toBe(2)
		expect(b.count(2)).toBe(1)
		expect(b.lastFeedTs(1)).toBe(300)
		expect(b.lastFeedTs(2)).toBe(50)
		expect(b.lastFeedTs(9)).toBeNull()
		expect(b.count(9)).toBe(0)
		expect(b.vehicles(9)).toEqual([])
	})

	test("applies upserts, removes and resets and notifies subscribers", () => {
		const b = bus()
		const seen: number[] = []
		const unsubscribe = b.subscribe((update) => seen.push(update.poll_id))
		b.apply({ binding_id: 1, poll_id: 1, feed_ts: 10, upsert: [live(1), live(2)], remove: [] })
		expect(b.vehicles(1).map((v) => v.vehicle_id)).toEqual([1, 2])
		b.apply({ binding_id: 1, poll_id: 2, feed_ts: 0, upsert: [], remove: [1] })
		expect(b.vehicle(1, 1)).toBeUndefined()
		expect(b.vehicle(1, 2)?.external_id).toBe("ext-2")
		// A zero feed time keeps the previous one.
		expect(b.lastFeedTs(1)).toBe(10)
		b.apply({
			binding_id: 1,
			poll_id: 3,
			feed_ts: 20,
			upsert: [live(5)],
			remove: [],
			reset: true,
		})
		expect(b.vehicles(1).map((v) => v.vehicle_id)).toEqual([5])
		unsubscribe()
		b.apply({ binding_id: 1, poll_id: 4, feed_ts: 30, upsert: [], remove: [] })
		expect(seen).toEqual([1, 2, 3])
	})

	test("finds a vehicle by external id within its binding", () => {
		const b = bus()
		b.apply({
			binding_id: 1,
			poll_id: 1,
			feed_ts: 10,
			upsert: [live(1, { external_id: "A" }), live(2, { external_id: "B" })],
			remove: [],
		})
		expect(b.byExternalId(1, "B")?.vehicle_id).toBe(2)
		expect(b.byExternalId(1, "Z")).toBeUndefined()
		expect(b.byExternalId(2, "A")).toBeUndefined()
		expect(b.vehicle(2, 1)).toBeUndefined()
	})

	test("reload replaces the whole map", () => {
		const rows: Partial<StateRow>[] = []
		const b = bus(rows)
		b.apply({ binding_id: 1, poll_id: 1, feed_ts: 10, upsert: [live(1)], remove: [] })
		rows.push({ ...live(9) })
		b.reload()
		expect(b.vehicles(1).map((v) => v.vehicle_id)).toEqual([9])
	})
})
