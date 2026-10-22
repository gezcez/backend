// gtfs.realtime.ts
// GTFS-Realtime protobuf feeds to the canonical model: VehiclePositions to RawVehicle,
// TripUpdates to TripUpdate and ServiceAlerts to ServiceAlert. Plain GTFS-RT ids are used as
// they are (no Kentkart pipe segments). Pure functions, tested with encoded fixtures.

import { transit_realtime } from "gtfs-realtime-bindings"
import type {
	RawVehicle,
	ServiceAlert,
	TripUpdate,
	TripUpdateStop,
} from "../transit-provider.interface"
import { parseGtfsDate, parseGtfsTime } from "./gtfs.static"

type LongLike = number | { toNumber(): number } | { low: number; high: number } | null | undefined

function longToNumber(value: unknown): number | undefined {
	const v = value as LongLike
	if (v === null || v === undefined) return undefined
	if (typeof v === "number") return v
	if ("toNumber" in v && typeof v.toNumber === "function") return v.toNumber()
	if ("low" in v) return (v.high >>> 0) * 2 ** 32 + (v.low >>> 0)
	return undefined
}

function text(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

export class RealtimeDecodeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RealtimeDecodeError"
	}
}

/** Decodes a FeedMessage; JSON or HTML bodies (error pages) are decode errors. */
export function decodeFeedMessage(body: Uint8Array): transit_realtime.FeedMessage {
	const head = new TextDecoder().decode(body.subarray(0, 1))
	if (head === "{" || head === "<") throw new RealtimeDecodeError("non-protobuf body")
	try {
		return transit_realtime.FeedMessage.decode(body)
	} catch (error) {
		throw new RealtimeDecodeError(`protobuf decode failed: ${(error as Error).message}`)
	}
}

export function feedTimestamp(feed: transit_realtime.IFeedMessage): number {
	return longToNumber(feed.header?.timestamp) ?? 0
}

// ---------- vehicle positions ----------

export function mapVehiclePositions(feed: transit_realtime.IFeedMessage): {
	feedTs: number
	entities: RawVehicle[]
	invalid: number
} {
	const feedTs = feedTimestamp(feed)
	const entities: RawVehicle[] = []
	let invalid = 0
	for (const entity of feed.entity ?? []) {
		if (!entity.vehicle) continue
		if (entity.isDeleted) continue
		const mapped = mapVehicle(entity, feedTs)
		if (mapped) entities.push(mapped)
		else invalid++
	}
	return { feedTs, entities, invalid }
}

function mapVehicle(entity: transit_realtime.IFeedEntity, feedTs: number): RawVehicle | null {
	const v = entity.vehicle!
	const externalId = text(v.vehicle?.id) ?? text(entity.id)
	const lat = v.position?.latitude
	const lon = v.position?.longitude
	if (!externalId || typeof lat !== "number" || typeof lon !== "number") return null
	if (lat === 0 && lon === 0) return null
	const vehicle: RawVehicle = {
		externalId,
		lat,
		lon,
		vehicleTs: longToNumber(v.timestamp) || feedTs,
	}
	const plate = text(v.vehicle?.licensePlate)
	if (plate) vehicle.plate = plate
	const label = text(v.vehicle?.label)
	if (label) vehicle.label = label
	const routeExt = text(v.trip?.routeId)
	if (routeExt) vehicle.routeExt = routeExt
	const direction = v.trip?.directionId
	if (direction === 0 || direction === 1) vehicle.direction = direction
	const tripExt = text(v.trip?.tripId)
	if (tripExt) vehicle.tripExt = tripExt
	const stopExt = text(v.stopId)
	if (stopExt) vehicle.stopExt = stopExt
	if (typeof v.currentStopSequence === "number") vehicle.stopSeq = v.currentStopSequence
	if (typeof v.currentStatus === "number") vehicle.status = v.currentStatus
	if (typeof v.position?.bearing === "number") vehicle.bearing = v.position.bearing
	if (typeof v.position?.speed === "number") vehicle.speedMs = v.position.speed
	return vehicle
}

// ---------- trip updates ----------

const TRIP_RELATIONSHIP: Record<number, TripUpdate["relationship"]> = {
	0: "scheduled",
	1: "added",
	2: "unscheduled",
	3: "canceled",
	5: "duplicated",
	6: "deleted",
}

export function mapTripUpdates(feed: transit_realtime.IFeedMessage): {
	feedTs: number
	updates: TripUpdate[]
} {
	const feedTs = feedTimestamp(feed)
	const updates: TripUpdate[] = []
	for (const entity of feed.entity ?? []) {
		const tu = entity.tripUpdate
		if (!tu || entity.isDeleted) continue
		const tripExt = text(tu.trip?.tripId)
		if (!tripExt) continue
		const update: TripUpdate = {
			tripExt,
			relationship: TRIP_RELATIONSHIP[tu.trip?.scheduleRelationship ?? 0] ?? "scheduled",
			stops: (tu.stopTimeUpdate ?? []).map((stu) => {
				const stop: TripUpdateStop = { skipped: stu.scheduleRelationship === 1 }
				if (typeof stu.stopSequence === "number") stop.stopSeq = stu.stopSequence
				const stopExt = text(stu.stopId)
				if (stopExt) stop.stopExt = stopExt
				if (typeof stu.arrival?.delay === "number") stop.arrivalDelayS = stu.arrival.delay
				const arrivalAt = longToNumber(stu.arrival?.time)
				if (arrivalAt) stop.arrivalAt = arrivalAt
				if (typeof stu.departure?.delay === "number")
					stop.departureDelayS = stu.departure.delay
				const departureAt = longToNumber(stu.departure?.time)
				if (departureAt) stop.departureAt = departureAt
				return stop
			}),
		}
		const routeExt = text(tu.trip?.routeId)
		if (routeExt) update.routeExt = routeExt
		const direction = tu.trip?.directionId
		if (direction === 0 || direction === 1) update.direction = direction
		const startDate = tu.trip?.startDate ? parseGtfsDate(tu.trip.startDate) : null
		if (startDate) update.startDate = startDate
		const startTime = tu.trip?.startTime ? parseGtfsTime(tu.trip.startTime) : null
		if (startTime !== null) update.startTimeS = startTime
		const vehicleExt = text(tu.vehicle?.id)
		if (vehicleExt) update.vehicleExt = vehicleExt
		if (typeof tu.delay === "number") update.delayS = tu.delay
		const timestamp = longToNumber(tu.timestamp)
		if (timestamp) update.timestamp = timestamp
		updates.push(update)
	}
	return { feedTs, updates }
}

// ---------- alerts ----------

function translate(
	value: transit_realtime.ITranslatedString | null | undefined,
	language: string,
): string {
	const list = value?.translation ?? []
	const lang = language.toLowerCase()
	const pick =
		list.find((t) => t.language?.toLowerCase() === lang) ??
		list.find((t) => t.language?.toLowerCase().split("-")[0] === lang) ??
		list.find((t) => !t.language) ??
		list[0]
	return pick?.text?.trim() ?? ""
}

/** GTFS-RT SeverityLevel (and the effect, when severity is unknown) to our three levels. */
function severityOf(alert: transit_realtime.IAlert): ServiceAlert["severity"] {
	switch (alert.severityLevel) {
		case 4:
			return "severe"
		case 3:
			return "warning"
		case 2:
			return "info"
	}
	// Effect: 1 no service, 2 reduced service, 3 significant delays, 4 detour.
	if (alert.effect === 1) return "severe"
	if (alert.effect === 2 || alert.effect === 3 || alert.effect === 4) return "warning"
	return "info"
}

/**
 * Alerts active now or later (an alert whose every period has ended is dropped). The period
 * reported is the current one, else the next one.
 */
export function mapAlerts(
	feed: transit_realtime.IFeedMessage,
	options: { language: string; nowS: number },
): ServiceAlert[] {
	const out: ServiceAlert[] = []
	for (const entity of feed.entity ?? []) {
		const alert = entity.alert
		if (!alert || entity.isDeleted) continue
		const periods = (alert.activePeriod ?? []).map((p) => ({
			from: longToNumber(p.start) ?? 0,
			to: longToNumber(p.end) || null,
		}))
		let period = { from: 0, to: null as number | null }
		if (periods.length) {
			const current = periods.find(
				(p) => p.from <= options.nowS && (p.to === null || p.to > options.nowS),
			)
			const next = periods
				.filter((p) => p.from > options.nowS)
				.sort((a, b) => a.from - b.from)[0]
			const chosen = current ?? next
			if (!chosen) continue
			period = chosen
		}
		const routeExts = [
			...new Set(
				(alert.informedEntity ?? [])
					.map((e) => text(e.routeId) ?? text(e.trip?.routeId))
					.filter((r): r is string => Boolean(r)),
			),
		]
		const title = translate(alert.headerText, options.language)
		const body = translate(alert.descriptionText, options.language)
		if (!title && !body) continue
		const url = translate(alert.url, options.language)
		out.push({
			externalId: text(entity.id) ?? `${period.from}:${title}`,
			title: title || body.slice(0, 120),
			body,
			severity: severityOf(alert),
			routeExts,
			activeFrom: period.from,
			activeTo: period.to,
			url: /^https?:\/\//.test(url) ? url : null,
		})
	}
	return out
}
