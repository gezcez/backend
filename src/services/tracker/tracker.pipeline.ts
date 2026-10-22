// tracker.pipeline.ts
// Normalise, filter and flag one feed (plan 8.5). Pure functions: the engine feeds in the previous
// sample per vehicle and gets back samples ready to store plus the drop counters for `polls`.

import { expandBBox, haversineM, inBBox, toE6 } from "@common/utils"
import { QUALITY, type PollDropped } from "@schemas/vts"
import type {
	BindingContext,
	DropReason,
	RawVehicle,
	VehicleFeed,
} from "@services/providers/transit-provider.interface"

/** A vehicle sample after normalisation; the unit the trip detector and the writer work on. */
export interface Sample {
	externalId: string
	plate: string | null
	label: string | null
	routeExt: string | null
	direction: number | null
	tripExt: string | null
	stopExt: string | null
	stopSeq: number | null
	status: number | null
	latE6: number
	lonE6: number
	bearingD10: number | null
	speedCms: number | null
	vehicleTs: number
	quality: number
	kindFlags: number
}

/** What the pipeline needs to know about the vehicle's previous sample. */
export interface PreviousSample {
	latE6: number
	lonE6: number
	vehicleTs: number
	tripExt: string | null
	runStartedAt: number | null
}

export const STALE_AFTER_S = 180
/** Samples older than this are not stored at all (counted as `stale`). */
export const DROP_STALE_AFTER_S = 3600
export const MAX_REPORTED_SPEED_MS = 30
export const MAX_IMPLIED_SPEED_MS = 50
export const FROZEN_TRIP_AFTER_S = 3 * 3600
const BBOX_MARGIN_M = 5000

export function emptyDropped(): PollDropped {
	return { staff: 0, test: 0, stale: 0, no_route: 0, out_of_bbox: 0, invalid: 0 }
}

function text(value: string | undefined | null): string | null {
	if (value === undefined || value === null) return null
	const trimmed = value.trim()
	return trimmed ? trimmed : null
}

/** Trip ids that do not identify a trip (some intercity lines report "0"). */
export function isKeyedByRoute(tripExt: string | null): boolean {
	return !tripExt || tripExt === "0"
}

export interface PipelineInput {
	feed: VehicleFeed
	binding: BindingContext
	classify: (vehicle: RawVehicle) => DropReason | null
	previous: (externalId: string) => PreviousSample | undefined
}

export interface PipelineResult {
	samples: Sample[]
	dropped: PollDropped
}

export function runPipeline({ feed, binding, classify, previous }: PipelineInput): PipelineResult {
	const dropped = emptyDropped()
	dropped.invalid += feed.invalid
	const bbox = binding.bbox ? expandBBox(binding.bbox, BBOX_MARGIN_M) : null
	// Same vehicle twice in one feed: keep the newest fix.
	const latest = new Map<string, RawVehicle>()
	for (const raw of feed.entities) {
		const id = text(raw.externalId)
		if (
			!id ||
			!Number.isFinite(raw.lat) ||
			!Number.isFinite(raw.lon) ||
			(raw.lat === 0 && raw.lon === 0) ||
			Math.abs(raw.lat) > 90 ||
			Math.abs(raw.lon) > 180 ||
			!Number.isFinite(raw.vehicleTs)
		) {
			dropped.invalid++
			continue
		}
		const seen = latest.get(id)
		if (!seen || seen.vehicleTs < raw.vehicleTs) latest.set(id, { ...raw, externalId: id })
	}

	const samples: Sample[] = []
	for (const raw of latest.values()) {
		const reason = classify(raw)
		if (reason) {
			dropped[reason]++
			continue
		}
		// A fix from the future is clamped to the feed time; very old fixes are not stored.
		const vehicleTs = Math.min(Math.floor(raw.vehicleTs), feed.feedTs)
		const age = feed.feedTs - vehicleTs
		if (age > DROP_STALE_AFTER_S) {
			dropped.stale++
			continue
		}
		const routeExt = text(raw.routeExt)
		if (!routeExt) dropped.no_route++
		let quality = 0
		if (age > STALE_AFTER_S) quality |= QUALITY.stale
		if (bbox && !inBBox(raw.lat, raw.lon, bbox)) {
			quality |= QUALITY.out_of_bbox
			dropped.out_of_bbox++
		}
		if (raw.speedMs !== undefined && raw.speedMs > MAX_REPORTED_SPEED_MS)
			quality |= QUALITY.speed_outlier
		const prev = previous(raw.externalId)
		const tripExt = text(raw.tripExt)
		if (prev && vehicleTs > prev.vehicleTs) {
			const metres = haversineM(prev.latE6 / 1e6, prev.lonE6 / 1e6, raw.lat, raw.lon)
			if (metres / (vehicleTs - prev.vehicleTs) > MAX_IMPLIED_SPEED_MS)
				quality |= QUALITY.jump
		}
		if (
			prev?.runStartedAt != null &&
			prev.tripExt === tripExt &&
			!isKeyedByRoute(tripExt) &&
			vehicleTs - prev.runStartedAt > FROZEN_TRIP_AFTER_S
		)
			quality |= QUALITY.frozen_trip
		samples.push({
			externalId: raw.externalId,
			plate: text(raw.plate),
			label: text(raw.label),
			routeExt,
			direction:
				raw.direction === 0 || raw.direction === 1 ? raw.direction : routeExt ? 0 : null,
			tripExt,
			stopExt: text(raw.stopExt),
			stopSeq: raw.stopSeq !== undefined && Number.isFinite(raw.stopSeq) ? raw.stopSeq : null,
			status: raw.status ?? null,
			latE6: toE6(raw.lat),
			lonE6: toE6(raw.lon),
			bearingD10:
				raw.bearing !== undefined && Number.isFinite(raw.bearing)
					? Math.round((((raw.bearing % 360) + 360) % 360) * 10)
					: null,
			speedCms:
				raw.speedMs !== undefined && Number.isFinite(raw.speedMs)
					? Math.max(0, Math.round(raw.speedMs * 100))
					: null,
			vehicleTs,
			quality,
			kindFlags: 0,
		})
	}
	return { samples, dropped }
}

/** Samples with these bits do not move trip runs forward (plan 8.6 "non-flagged sample"). */
export const RUN_BLOCKING_QUALITY = QUALITY.stale | QUALITY.jump | QUALITY.out_of_bbox
