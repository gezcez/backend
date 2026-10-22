// trip-detector.ts
// Trip start and end detection (plan 8.6). The state lives in vehicle_state and trip_runs and is
// written in the same transaction as positions, so a restart continues where it stopped. This
// file is pure: it mutates the in-memory TrackedVehicle and returns the run events to persist.

import type { TripEndReason } from "@schemas/vts"
import { isKeyedByRoute, RUN_BLOCKING_QUALITY, type Sample } from "./tracker.pipeline"

export interface OpenRun {
	/** trip_runs.id, set by the writer when the open event is stored. */
	id: number | null
	tripExt: string | null
	routeExt: string
	direction: number | null
	keyedByRoute: boolean
	startedAt: number
	lastTs: number
	firstStopSeq: number | null
	lastStopSeq: number | null
	maxStopSeq: number | null
	samples: number
	scheduledStartS: number | null
	startDelayS: number | null
}

export interface TrackedVehicle {
	vehicleId: number
	bindingId: number
	externalId: string
	sample: Sample
	feedTs: number
	live: boolean
	run: OpenRun | null
	lastSeenFeedTs: number
	missingPolls: number
}

export type RunEvent =
	| { kind: "open"; vehicle: TrackedVehicle; run: OpenRun }
	| { kind: "extend"; vehicle: TrackedVehicle; run: OpenRun }
	| {
			kind: "close"
			vehicle: TrackedVehicle
			run: OpenRun
			endedAt: number
			reason: TripEndReason
	  }

export interface DetectorHooks {
	/** Stops on the active pattern of route/direction, if the static data knows it. */
	patternLength(routeExt: string, direction: number | null): number | undefined
	/** Timetable match for a freshly opened run (trip id, else nearest start within 20 min). */
	schedule(
		run: OpenRun,
		vehicleTs: number,
	): { scheduledStartS: number; startDelayS: number } | null
}

export const MISSING_POLLS_TO_CLOSE = 3
export const MISSING_SECONDS_TO_CLOSE = 150
/** A restart gap longer than this closes every open run with `gap`. */
export const RESTART_GAP_S = 300

function runKeyOfSample(sample: Sample): string | null {
	if (!sample.routeExt) return null
	if (isKeyedByRoute(sample.tripExt)) return `r|${sample.routeExt}|${sample.direction ?? ""}`
	return `t|${sample.tripExt}|${sample.routeExt}|${sample.direction ?? ""}`
}

export function runKey(run: OpenRun): string {
	return run.keyedByRoute
		? `r|${run.routeExt}|${run.direction ?? ""}`
		: `t|${run.tripExt}|${run.routeExt}|${run.direction ?? ""}`
}

export class TripDetector {
	constructor(private readonly hooks: DetectorHooks) {}

	private endReason(run: OpenRun, fallback: TripEndReason): TripEndReason {
		const length = this.hooks.patternLength(run.routeExt, run.direction)
		if (length !== undefined && run.lastStopSeq !== null && run.lastStopSeq >= length - 1)
			return "completed"
		return fallback
	}

	private close(vehicle: TrackedVehicle, reason: TripEndReason): RunEvent[] {
		const run = vehicle.run
		if (!run) return []
		vehicle.run = null
		return [{ kind: "close", vehicle, run, endedAt: run.lastTs, reason }]
	}

	/** The vehicle is in this feed with `sample`. */
	present(vehicle: TrackedVehicle, sample: Sample, feedTs: number): RunEvent[] {
		vehicle.missingPolls = 0
		vehicle.lastSeenFeedTs = feedTs
		vehicle.live = true
		vehicle.feedTs = feedTs
		vehicle.sample = sample
		if (sample.quality & RUN_BLOCKING_QUALITY) return []
		const events: RunEvent[] = []
		const key = runKeyOfSample(sample)
		if (vehicle.run && key !== runKey(vehicle.run)) {
			// Each event keeps its own time: the old run ends at its last sample, the new one
			// starts at this sample.
			events.push(...this.close(vehicle, this.endReason(vehicle.run, "trip_change")))
		}
		if (key === null) return events
		const run = vehicle.run
		if (!run) {
			const opened: OpenRun = {
				id: null,
				tripExt: sample.tripExt,
				routeExt: sample.routeExt!,
				direction: sample.direction,
				keyedByRoute: isKeyedByRoute(sample.tripExt),
				startedAt: sample.vehicleTs,
				lastTs: sample.vehicleTs,
				firstStopSeq: sample.stopSeq,
				lastStopSeq: sample.stopSeq,
				maxStopSeq: sample.stopSeq,
				samples: 1,
				scheduledStartS: null,
				startDelayS: null,
			}
			const match = opened.keyedByRoute ? null : this.hooks.schedule(opened, sample.vehicleTs)
			if (match) {
				opened.scheduledStartS = match.scheduledStartS
				opened.startDelayS = match.startDelayS
			}
			vehicle.run = opened
			events.push({ kind: "open", vehicle, run: opened })
		} else if (sample.vehicleTs > run.lastTs) {
			run.samples++
			run.lastTs = sample.vehicleTs
			if (sample.stopSeq !== null) {
				run.lastStopSeq = sample.stopSeq
				run.maxStopSeq = Math.max(run.maxStopSeq ?? sample.stopSeq, sample.stopSeq)
			}
			events.push({ kind: "extend", vehicle, run })
		}
		return events
	}

	/**
	 * The vehicle is not in this (accepted) feed. One missed poll does not end a run: it takes
	 * three missed polls and at least 150 s.
	 */
	absent(vehicle: TrackedVehicle, feedTs: number): RunEvent[] {
		if (!vehicle.live) return []
		vehicle.missingPolls++
		if (
			vehicle.missingPolls < MISSING_POLLS_TO_CLOSE ||
			feedTs - vehicle.lastSeenFeedTs < MISSING_SECONDS_TO_CLOSE
		)
			return []
		vehicle.live = false
		return vehicle.run ? this.close(vehicle, this.endReason(vehicle.run, "disappeared")) : []
	}

	/** Ends the vehicle's run (kill switch, restart gap) and takes it off the live map. */
	closeAll(vehicle: TrackedVehicle, reason: TripEndReason): RunEvent[] {
		vehicle.live = false
		vehicle.missingPolls = 0
		return this.close(vehicle, reason)
	}
}
