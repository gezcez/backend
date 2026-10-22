// kentkart.mapper.ts
// Upstream shapes to the canonical model: GTFS-RT entities to RawVehicle, route/list and pathInfo
// to GTFS-shaped static rows. Pure functions, tested against fixtures.

import { transit_realtime } from "gtfs-realtime-bindings"
import type {
	RawVehicle,
	StaticPattern,
	StaticRoute,
	StaticService,
	StaticStop,
	StaticTrip,
	StaticAgency,
} from "../transit-provider.interface"
import type {
	KentkartPath,
	KentkartRouteListItem,
	KentkartSchedule,
	KentkartTimeListItem,
} from "./kentkart.types"

type LongLike = number | { toNumber(): number } | { low: number; high: number } | null | undefined

/** protobufjs gives int64 as Long objects (or numbers when small). */
export function longToNumber(value: LongLike): number | undefined {
	if (value === null || value === undefined) return undefined
	if (typeof value === "number") return value
	if ("toNumber" in value && typeof value.toNumber === "function") return value.toNumber()
	if ("low" in value) return (value.high >>> 0) * 2 ** 32 + (value.low >>> 0)
	return undefined
}

/** First segment of a pipe-encoded id ("41265|1|x" -> "41265"); empty strings become undefined. */
export function firstSegment(value: string | null | undefined): string | undefined {
	if (!value) return undefined
	const head = value.split("|")[0]?.trim()
	return head ? head : undefined
}

function toNumber(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) ? n : undefined
}

export interface DecodedFeed {
	feedTs: number
	entities: RawVehicle[]
	invalid: number
}

export class FeedDecodeError extends Error {
	constructor(
		message: string,
		readonly upstreamCode?: number,
	) {
		super(message)
		this.name = "FeedDecodeError"
	}
}

/**
 * Decodes a GTFS-RT VehiclePositions body. A JSON body is Kentkart's error envelope and is
 * reported with its `result.code`.
 */
export function decodeVehicleFeed(body: Uint8Array): DecodedFeed {
	const head = new TextDecoder().decode(body.subarray(0, 1))
	if (head === "{" || head === "<") {
		const text = new TextDecoder().decode(body)
		let code: number | undefined
		let message = "non-protobuf body"
		try {
			const json = JSON.parse(text) as { result?: { code?: unknown; message?: unknown } }
			code = toNumber(json.result?.code)
			message = String(json.result?.message ?? "JSON error envelope")
		} catch {
			// HTML or garbage
		}
		throw new FeedDecodeError(message, code)
	}
	let feed: InstanceType<typeof transit_realtime.FeedMessage>
	try {
		feed = transit_realtime.FeedMessage.decode(body)
	} catch (error) {
		throw new FeedDecodeError(`protobuf decode failed: ${(error as Error).message}`)
	}
	return mapFeedMessage(feed)
}

export function mapFeedMessage(feed: transit_realtime.IFeedMessage): DecodedFeed {
	const feedTs = longToNumber(feed.header?.timestamp as LongLike) ?? 0
	const entities: RawVehicle[] = []
	let invalid = 0
	for (const entity of feed.entity ?? []) {
		const mapped = mapEntity(entity, feedTs)
		if (mapped) entities.push(mapped)
		else invalid++
	}
	return { feedTs, entities, invalid }
}

function mapEntity(entity: transit_realtime.IFeedEntity, feedTs: number): RawVehicle | null {
	const v = entity.vehicle
	if (!v) return null
	const externalId = firstSegment(v.vehicle?.id) ?? firstSegment(entity.id)
	const lat = v.position?.latitude
	const lon = v.position?.longitude
	if (!externalId || lat === undefined || lon === undefined || lat === null || lon === null)
		return null
	if (lat === 0 && lon === 0) return null
	const routeParts = (v.trip?.routeId ?? "").split("|")
	const routeExt = routeParts[0]?.trim() || undefined
	const direction = toNumber(routeParts[1] ?? v.trip?.directionId)
	const tripExt = firstSegment(v.trip?.tripId)
	const vehicleTs = longToNumber(v.timestamp as LongLike) ?? feedTs
	const vehicle: RawVehicle = {
		externalId,
		lat,
		lon,
		vehicleTs,
	}
	if (v.vehicle?.licensePlate) vehicle.plate = v.vehicle.licensePlate.trim()
	if (v.vehicle?.label) vehicle.label = v.vehicle.label.trim()
	if (routeExt) vehicle.routeExt = routeExt
	if (direction === 0 || direction === 1) vehicle.direction = direction
	if (tripExt && tripExt !== "0") vehicle.tripExt = tripExt
	const stopExt = firstSegment(v.stopId)
	if (stopExt) vehicle.stopExt = stopExt
	if (typeof v.currentStopSequence === "number") vehicle.stopSeq = v.currentStopSequence
	if (typeof v.currentStatus === "number") vehicle.status = v.currentStatus
	if (typeof v.position?.bearing === "number") vehicle.bearing = v.position.bearing
	if (typeof v.position?.speed === "number") vehicle.speedMs = v.position.speed
	return vehicle
}

// ---------- static ----------

const GTFS_ROUTE_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 11, 12])

function colour(value: string | undefined | null): string | null {
	if (!value) return null
	const hex = value.replace(/^#/, "").trim()
	return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null
}

export function mapRouteList(items: KentkartRouteListItem[]): {
	routes: StaticRoute[]
	agencies: StaticAgency[]
} {
	const routes = new Map<string, StaticRoute>()
	const agencies = new Map<string, StaticAgency>()
	for (const item of items) {
		if (item.type && item.type !== "route") continue
		const externalId = String(item.routeCode ?? "").trim()
		if (!externalId || !item.displayRouteCode) continue
		const type = toNumber(item.routeType)
		const agencyExternalId =
			item.agencyId !== undefined && item.agencyId !== "" ? String(item.agencyId) : null
		if (agencyExternalId && !agencies.has(agencyExternalId)) {
			agencies.set(agencyExternalId, {
				externalId: agencyExternalId,
				name: item.agencyName?.trim() || agencyExternalId,
			})
		}
		routes.set(externalId, {
			externalId,
			shortName: item.displayRouteCode.trim(),
			longName: (item.name ?? "").trim(),
			routeType: type !== undefined && GTFS_ROUTE_TYPES.has(type) ? type : 3,
			color: colour(item.routeColor),
			textColor: colour(item.routeTextColor),
			agencyExternalId,
			isPublic: true,
		})
	}
	const sorted = [...routes.values()].sort((a, b) =>
		a.shortName.localeCompare(b.shortName, "tr", { numeric: true }),
	)
	sorted.forEach((route, index) => (route.sort = index))
	return { routes: sorted, agencies: [...agencies.values()] }
}

/** "MTWTFss" -> Mon..Fri. Uppercase letters mark active days, Monday first. */
export function daysMaskFromDescription(description: string): number {
	let mask = 0
	const letters = [...description.trim()].slice(0, 7)
	letters.forEach((letter, index) => {
		if (letter !== letter.toLowerCase() && letter === letter.toUpperCase()) mask |= 1 << index
	})
	return mask
}

/** "07:30" -> 27000, "25:10" -> 90600. Returns undefined for anything else. */
export function parseClock(value: string | undefined | null): number | undefined {
	if (!value) return undefined
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
	if (!match) return undefined
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0)
}

/** Stop offsets arrive as seconds ("540") or clock strings ("00:09:00"). */
export function parseOffset(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined || value === "") return null
	if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null
	const clock = parseClock(value)
	if (clock !== undefined) return clock
	const n = Number(value)
	return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

/** Departure times in list order; a time that jumps back by more than 12 h is after midnight. */
export function startTimes(times: KentkartTimeListItem[]): number[] {
	const result: number[] = []
	let previous = -1
	let dayOffset = 0
	for (const item of times) {
		const clock = parseClock(item.departureTime)
		if (clock === undefined) {
			result.push(Number.NaN)
			continue
		}
		if (previous >= 0 && clock + dayOffset < previous - 12 * 3600) dayOffset += 86400
		const value = clock + dayOffset
		result.push(value)
		previous = value
	}
	return result
}

export interface MappedPath {
	pattern: StaticPattern
	stops: StaticStop[]
	services: StaticService[]
	trips: StaticTrip[]
}

export function patternExternalId(routeExt: string, path: KentkartPath): string {
	const code = String(path.path_code ?? "").trim()
	return code ? `${routeExt}.${code}` : `${routeExt}.d${toNumber(path.direction) ?? 0}`
}

/** Maps one direction of pathInfo for route `routeExt`. */
export function mapPath(routeExt: string, path: KentkartPath): MappedPath {
	const direction = toNumber(path.direction) === 1 ? 1 : 0
	const patternId = patternExternalId(routeExt, path)
	const stopsInOrder = [...(path.busStopList ?? [])].sort(
		(a, b) => (toNumber(a.seq) ?? 0) - (toNumber(b.seq) ?? 0),
	)
	const stops: StaticStop[] = []
	for (const stop of stopsInOrder) {
		const lat = toNumber(stop.lat)
		const lon = toNumber(stop.lng)
		if (lat === undefined || lon === undefined) continue
		stops.push({
			externalId: String(stop.stopId),
			name: (stop.stopName ?? "").trim() || String(stop.stopId),
			code: stop.stopCode ?? String(stop.stopId),
			lat,
			lon,
		})
	}
	const shape = [...(path.pointList ?? [])]
		.sort((a, b) => (toNumber(a.seq) ?? 0) - (toNumber(b.seq) ?? 0))
		.map((p) => [toNumber(p.lat), toNumber(p.lng)] as const)
		.filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined)
		.map(([lat, lon]) => [lat, lon] as [number, number])
	const pattern: StaticPattern = {
		externalId: patternId,
		routeExternalId: routeExt,
		direction,
		headsign: (path.headSign ?? path.direction_name ?? "").trim(),
		shape,
		stops: stopsInOrder
			.filter((s) => toNumber(s.lat) !== undefined && toNumber(s.lng) !== undefined)
			.map((s) => ({
				stopExternalId: String(s.stopId),
				offsetS: parseOffset(s.departure_offset ?? s.arrival_offset),
			})),
	}
	const services: StaticService[] = []
	const trips: StaticTrip[] = []
	for (const schedule of path.scheduleList ?? []) {
		const service = mapSchedule(schedule)
		services.push(service)
		const times = schedule.timeList ?? []
		const starts = startTimes(times)
		times.forEach((item, index) => {
			const start = starts[index]
			const tripId = String(item.tripId ?? "").trim()
			if (start === undefined || Number.isNaN(start) || !tripId || tripId === "0") return
			trips.push({
				externalId: tripId,
				patternExternalId: patternId,
				serviceExternalId: service.externalId,
				startTimeS: start,
				headsign: item.tripHeadSign?.trim() || null,
				color: colour(item.patternColor),
			})
		})
	}
	return { pattern, stops, services, trips }
}

function mapSchedule(schedule: KentkartSchedule): StaticService {
	return {
		externalId: String(schedule.serviceId),
		daysMask: daysMaskFromDescription(schedule.description ?? ""),
		label: schedule.description ?? null,
	}
}
