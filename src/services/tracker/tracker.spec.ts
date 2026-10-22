import { describe, expect, test } from "bun:test"
import { QUALITY } from "@schemas/vts"
import type {
	BindingContext,
	RawVehicle,
	VehicleFeed,
} from "@services/providers/transit-provider.interface"
import { runPipeline, type PreviousSample, type Sample } from "./tracker.pipeline"
import {
	Breaker,
	backoffDelay,
	baseInterval,
	inQuietHours,
	jittered,
	MAX_BACKOFF_S,
	startOffset,
} from "./tracker.scheduler"
import { TripDetector, type DetectorHooks, type TrackedVehicle } from "./trip-detector"

const binding: BindingContext = {
	id: 1,
	networkId: 1,
	providerKey: "fake",
	externalRef: "x",
	config: {},
	bbox: [29.25, 40.5, 30.4, 41.2],
	timezone: "Europe/Istanbul",
}

function raw(partial: Partial<RawVehicle> = {}): RawVehicle {
	return {
		externalId: "100",
		lat: 40.76,
		lon: 29.94,
		vehicleTs: 1000,
		routeExt: "41C",
		direction: 0,
		tripExt: "T1",
		stopSeq: 3,
		...partial,
	}
}

function feed(entities: RawVehicle[], feedTs = 1010, invalid = 0): VehicleFeed {
	return { feedTs, entities, urlVariant: "primary", bytes: 0, invalid }
}

function pipe(
	entities: RawVehicle[],
	previous: Record<string, PreviousSample> = {},
	feedTs = 1010,
) {
	return runPipeline({
		feed: feed(entities, feedTs),
		binding,
		classify: (v) => (v.label === "GÖREVLİ" ? "staff" : v.plate === "BLD4TEST" ? "test" : null),
		previous: (id) => previous[id],
	})
}

describe("pipeline", () => {
	test("normalises units and keeps the newest fix per vehicle", () => {
		const { samples, dropped } = pipe([
			raw({ vehicleTs: 990 }),
			raw({ vehicleTs: 1000, bearing: -90, speedMs: 7.25 }),
		])
		expect(samples).toHaveLength(1)
		expect(samples[0]).toMatchObject({
			latE6: 40760000,
			lonE6: 29940000,
			bearingD10: 2700,
			speedCms: 725,
			vehicleTs: 1000,
			quality: 0,
		})
		expect(dropped.invalid).toBe(0)
	})

	test("drops invalid, staff, test and very stale vehicles with counts", () => {
		const { samples, dropped } = pipe(
			[
				raw({ externalId: "" }),
				raw({ externalId: "2", lat: 0, lon: 0 }),
				raw({ externalId: "3", label: "GÖREVLİ" }),
				raw({ externalId: "4", plate: "BLD4TEST" }),
				raw({ externalId: "5", vehicleTs: 1010 - 4000 }),
				raw({ externalId: "6", routeExt: undefined }),
			],
			{},
		)
		expect(dropped).toMatchObject({ invalid: 2, staff: 1, test: 1, stale: 1, no_route: 1 })
		expect(samples.map((s) => s.externalId)).toEqual(["6"])
	})

	test("flags stale, out of bbox, speed outliers, jumps and frozen trips", () => {
		const { samples } = pipe(
			[
				raw({ externalId: "a", vehicleTs: 20000 - 400 }),
				raw({ externalId: "b", lat: 39.0, vehicleTs: 20000 }),
				raw({ externalId: "c", speedMs: 45, vehicleTs: 20000 }),
				raw({ externalId: "d", lat: 40.86, vehicleTs: 20000 }),
				raw({ externalId: "e", vehicleTs: 20000 }),
			],
			{
				d: {
					latE6: 40760000,
					lonE6: 29940000,
					vehicleTs: 19990,
					tripExt: "T1",
					runStartedAt: 19900,
				},
				e: {
					latE6: 40760000,
					lonE6: 29940000,
					vehicleTs: 19000,
					tripExt: "T1",
					runStartedAt: 100,
				},
			},
			20000,
		)
		const q = Object.fromEntries(samples.map((s) => [s.externalId, s.quality]))
		expect(q.a! & QUALITY.stale).toBeTruthy()
		expect(q.b! & QUALITY.out_of_bbox).toBeTruthy()
		expect(q.c! & QUALITY.speed_outlier).toBeTruthy()
		expect(q.d! & QUALITY.jump).toBeTruthy()
		expect(q.e! & QUALITY.frozen_trip).toBeTruthy()
	})
})

const hooks: DetectorHooks = {
	patternLength: () => 10,
	schedule: () => ({ scheduledStartS: 3600, startDelayS: 60 }),
}

function sample(partial: Partial<Sample>): Sample {
	return {
		externalId: "100",
		plate: null,
		label: null,
		routeExt: "41C",
		direction: 0,
		tripExt: "T1",
		stopExt: null,
		stopSeq: 1,
		status: 2,
		latE6: 0,
		lonE6: 0,
		bearingD10: null,
		speedCms: null,
		vehicleTs: 1000,
		quality: 0,
		kindFlags: 0,
		...partial,
	}
}

function vehicle(): TrackedVehicle {
	return {
		vehicleId: 1,
		bindingId: 1,
		externalId: "100",
		sample: sample({}),
		feedTs: 0,
		live: false,
		run: null,
		lastSeenFeedTs: 0,
		missingPolls: 0,
	}
}

describe("trip detector", () => {
	test("opens, extends and closes on a trip change with each event at its own time", () => {
		const d = new TripDetector(hooks)
		const v = vehicle()
		const opened = d.present(v, sample({ vehicleTs: 1000, stopSeq: 1 }), 1005)
		expect(opened.map((e) => e.kind)).toEqual(["open"])
		expect(v.run).toMatchObject({ startedAt: 1000, scheduledStartS: 3600, startDelayS: 60 })
		d.present(v, sample({ vehicleTs: 1030, stopSeq: 4 }), 1035)
		// Same fix again does not count as a sample.
		expect(d.present(v, sample({ vehicleTs: 1030, stopSeq: 4 }), 1065)).toEqual([])
		expect(v.run).toMatchObject({ samples: 2, lastTs: 1030, maxStopSeq: 4 })
		const change = d.present(v, sample({ vehicleTs: 1090, tripExt: "T2", stopSeq: 1 }), 1095)
		expect(change.map((e) => e.kind)).toEqual(["close", "open"])
		expect(change[0]).toMatchObject({ endedAt: 1030, reason: "trip_change" })
		expect(v.run).toMatchObject({ tripExt: "T2", startedAt: 1090 })
	})

	test("a run that reached the last stops closes as completed", () => {
		const d = new TripDetector(hooks)
		const v = vehicle()
		d.present(v, sample({ stopSeq: 1 }), 1000)
		d.present(v, sample({ vehicleTs: 1500, stopSeq: 9 }), 1500)
		const events = d.present(v, sample({ vehicleTs: 1600, tripExt: "T9" }), 1600)
		expect(events[0]).toMatchObject({ kind: "close", reason: "completed", endedAt: 1500 })
	})

	test("one missed poll does not end a run; three and 150 s do", () => {
		const d = new TripDetector(hooks)
		const v = vehicle()
		d.present(v, sample({ vehicleTs: 1000 }), 1000)
		expect(d.absent(v, 1030)).toEqual([])
		d.present(v, sample({ vehicleTs: 1060 }), 1060)
		expect(v.run?.samples).toBe(2)
		expect(d.absent(v, 1090)).toEqual([])
		expect(d.absent(v, 1120)).toEqual([])
		// Third miss but only 120 s since the vehicle was seen.
		expect(d.absent(v, 1180)).toEqual([])
		expect(v.live).toBe(true)
		const closed = d.absent(v, 1240)
		expect(closed[0]).toMatchObject({ kind: "close", reason: "disappeared", endedAt: 1060 })
		expect(v.live).toBe(false)
		expect(d.absent(v, 1300)).toEqual([])
	})

	test("trip id 0 is keyed by route and is not matched to the timetable", () => {
		let matched = 0
		const d = new TripDetector({ ...hooks, schedule: () => (matched++, null) })
		const v = vehicle()
		d.present(v, sample({ tripExt: "0" }), 1000)
		expect(v.run).toMatchObject({ keyedByRoute: true })
		expect(matched).toBe(0)
		// A different "0" sample on the same route continues the run.
		expect(d.present(v, sample({ tripExt: null, vehicleTs: 1100 }), 1100)[0]?.kind).toBe(
			"extend",
		)
	})

	test("flagged samples keep the vehicle present without moving the run", () => {
		const d = new TripDetector(hooks)
		const v = vehicle()
		d.present(v, sample({}), 1000)
		const events = d.present(
			v,
			sample({ tripExt: "T7", vehicleTs: 1100, quality: QUALITY.jump }),
			1100,
		)
		expect(events).toEqual([])
		expect(v.run?.tripExt).toBe("T1")
		expect(v.missingPolls).toBe(0)
	})

	test("closeAll ends the run at its last sample", () => {
		const d = new TripDetector(hooks)
		const v = vehicle()
		d.present(v, sample({ vehicleTs: 1000 }), 1000)
		expect(d.closeAll(v, "killed")[0]).toMatchObject({ reason: "killed", endedAt: 1000 })
		expect(v.live).toBe(false)
	})
})

describe("scheduler", () => {
	const input = {
		pollIntervalS: 30,
		idlePollIntervalS: 60,
		watched: false,
		localSecondsOfDay: 12 * 3600,
		quietHours: { start: 5400, end: 18000 },
		vehiclesInLastPoll: 10,
	}

	test("active, idle, floor and quiet hours", () => {
		expect(baseInterval(input)).toBe(60)
		expect(baseInterval({ ...input, watched: true })).toBe(30)
		expect(baseInterval({ ...input, watched: true, pollIntervalS: 5 })).toBe(15)
		const night = { ...input, localSecondsOfDay: 3 * 3600 }
		expect(baseInterval(night)).toBe(60)
		expect(baseInterval({ ...night, vehiclesInLastPoll: 0 })).toBe(300)
		expect(inQuietHours(23 * 3600, { start: 22 * 3600, end: 3600 })).toBe(true)
		expect(inQuietHours(2 * 3600, { start: 22 * 3600, end: 3600 })).toBe(false)
	})

	test("jitter, backoff cap with full jitter, Retry-After and stagger", () => {
		expect(jittered(30, 0)).toBe(27)
		expect(jittered(30, 0.999)).toBeCloseTo(32.97, 1)
		expect(backoffDelay(30, 2, 0.999)).toBeCloseTo(119.9, 0)
		expect(backoffDelay(30, 20, 0.999)).toBeLessThanOrEqual(MAX_BACKOFF_S)
		expect(backoffDelay(30, 1, 0)).toBe(15)
		expect(backoffDelay(30, 1, 0, 120)).toBe(120)
		expect(startOffset(4, 30)).toBe(startOffset(4, 30))
		expect(startOffset(4, 30)).toBeLessThan(30)
	})

	test("breaker: degraded after three failures, down after 15 minutes", () => {
		const b = new Breaker()
		b.failure(0, "x")
		b.failure(30, "x")
		expect(b.state).toBe("unknown")
		expect(b.failure(60, "x").changed).toBe(true)
		expect(b.state).toBe("degraded")
		b.failure(901, "x")
		expect(b.state).toBe("down")
		expect(b.success().changed).toBe(true)
		expect(b.state).toBe("ok")
		b.failure(1000, "rejected", true)
		expect(b.state).toBe("down")
	})
})
