// gtfs.static.ts
// GTFS static feed to the canonical static model (plan 5.2): agency, routes, stops, calendar,
// calendar_dates, trips, stop_times, frequencies and shapes. Stop times are not materialised;
// trips with the same route, direction, shape, stop sequence and running times share a pattern,
// and each trip keeps only its start time. Pure apart from reading the source; tested against
// small fixture feeds.

import { haversineM, localTime } from "@common/utils"
import type {
	StaticAgency,
	StaticPattern,
	StaticRoute,
	StaticService,
	StaticStop,
	StaticTrip,
} from "../transit-provider.interface"
import { csvRows, GtfsTable } from "./gtfs.csv"

/** Where GTFS files come from (a zip archive, or a map of files in tests). */
export interface GtfsSource {
	/** Uncompressed bytes of `file` (e.g. "stops.txt"), or null when the feed lacks it. */
	open(file: string): AsyncIterable<Uint8Array> | null
}

export interface GtfsImportOptions {
	encoding?: string
	/** Only routes of these agencies; empty keeps all. */
	agencyIds?: string[]
	/** Only these route types (GTFS basic or extended); empty keeps all. */
	routeTypes?: number[]
	/** The city's time zone: trip start times are expressed in its local day. */
	cityTimezone: string
	/** Overrides agency_timezone. */
	feedTimezone?: string | null
	/** Unix seconds used for the time zone offset when the feed and the city differ. */
	nowS?: number
}

export interface GtfsStatic {
	agencies: StaticAgency[]
	routes: StaticRoute[]
	stops: StaticStop[]
	services: StaticService[]
	patterns: StaticPattern[]
	trips: StaticTrip[]
	warnings: string[]
	/** The time zone the stop times were read in. */
	timezone: string
}

export class GtfsFeedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "GtfsFeedError"
	}
}

// ---------- field parsers ----------

/** "H:MM:SS" / "HH:MM:SS" (hours may exceed 24) to seconds after midnight; null when invalid. */
export function parseGtfsTime(value: string): number | null {
	const match = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
	if (!match) return null
	const h = Number(match[1])
	const m = Number(match[2])
	const s = match[3] === undefined ? 0 : Number(match[3])
	if (m > 59 || s > 59) return null
	return h * 3600 + m * 60 + s
}

/** "YYYYMMDD" to "YYYY-MM-DD"; null when invalid. */
export function parseGtfsDate(value: string): string | null {
	const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim())
	if (!match) return null
	const iso = `${match[1]}-${match[2]}-${match[3]}`
	const d = new Date(`${iso}T12:00:00Z`)
	return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso
}

/** "1d4ed8" or "#1D4ED8" to "#1d4ed8"; null when absent or invalid. */
export function parseGtfsColour(value: string): string | null {
	const hex = value.trim().replace(/^#/, "")
	return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null
}

/** Extended (Google/HVT) route types to the basic GTFS set the apps understand. */
export function basicRouteType(type: number): number {
	if (type >= 0 && type <= 12) return type
	if (type >= 100 && type < 200) return 2 // railway
	if (type >= 200 && type < 300) return 3 // coach
	if (type >= 400 && type < 500) return 1 // urban rail, metro
	if (type >= 700 && type < 800) return 3 // bus
	if (type === 800) return 11 // trolleybus
	if (type >= 900 && type < 1000) return 0 // tram
	if (type >= 1000 && type < 1300) return 4 // water
	if (type === 1300) return 6 // aerial lift
	if (type === 1400) return 7 // funicular
	return 3
}

const WEEKDAY_COLUMNS = [
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
	"sunday",
] as const

/** "MTWTFss" style label (capital = runs), as the Kentkart adapter writes it. */
export function daysLabel(mask: number): string {
	return "MTWTFSS"
		.split("")
		.map((c, i) => (mask & (1 << i) ? c : c.toLowerCase()))
		.join("")
}

/** Seconds the zone is ahead of UTC at `nowS`. */
export function zoneOffsetS(timeZone: string, nowS: number): number {
	const local = localTime(nowS, timeZone)
	const asUtc = Date.parse(`${local.date}T00:00:00Z`) / 1000 + local.secondsOfDay
	return Math.round((asUtc - nowS) / 60) * 60
}

function validZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en", { timeZone })
		return true
	} catch {
		return false
	}
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

// ---------- reading ----------

class Warnings {
	private readonly counts = new Map<string, number>()
	readonly list: string[] = []

	add(message: string): void {
		this.list.push(message)
	}

	/** Counted problems become one line each at the end ("12 stop_times rows ..."). */
	count(key: string, n = 1): void {
		this.counts.set(key, (this.counts.get(key) ?? 0) + n)
	}

	finish(): string[] {
		for (const [key, n] of this.counts) this.list.push(`${n} ${key}`)
		return this.list
	}
}

async function readFile(
	source: GtfsSource,
	file: string,
	encoding: string,
	onRow: (row: string[], table: GtfsTable) => void,
): Promise<boolean> {
	const bytes = source.open(file)
	if (!bytes) return false
	let table: GtfsTable | null = null
	for await (const batch of csvRows(bytes, encoding)) {
		for (const row of batch) {
			if (!table) {
				table = new GtfsTable(row)
				continue
			}
			onRow(row, table)
		}
	}
	return true
}

/** Column getters cached per table so the row loops stay cheap. */
function columns<K extends string>(
	table: GtfsTable,
	names: readonly K[],
	cache: { table?: GtfsTable; get?: Record<K, (row: string[]) => string> },
): Record<K, (row: string[]) => string> {
	if (cache.table !== table || !cache.get) {
		cache.table = table
		cache.get = Object.fromEntries(names.map((n) => [n, table.column(n)])) as Record<
			K,
			(row: string[]) => string
		>
	}
	return cache.get
}

interface TripInfo {
	routeId: string
	serviceId: string
	headsign: string
	direction: 0 | 1
	shapeId: string
}

/** stop_times of one trip in file order; sorted by stop_sequence when building patterns. */
interface TripTimes {
	seq: number[]
	stop: number[]
	/** Seconds after midnight, NaN when the row has no time. */
	time: number[]
}

// ---------- import ----------

export async function importGtfs(
	source: GtfsSource,
	options: GtfsImportOptions,
): Promise<GtfsStatic> {
	const encoding = options.encoding ?? "utf-8"
	const warnings = new Warnings()

	// agency.txt
	const agencies: StaticAgency[] = []
	let agencyZone: string | null = null
	const agencyCols = [
		"agency_id",
		"agency_name",
		"agency_url",
		"agency_phone",
		"agency_timezone",
	] as const
	const agencyCache = {}
	const hasAgency = await readFile(source, "agency.txt", encoding, (row, table) => {
		const c = columns(table, agencyCols, agencyCache)
		const name = c.agency_name(row)
		agencies.push({
			externalId: c.agency_id(row) || "default",
			name: name || c.agency_id(row) || "Agency",
			url: c.agency_url(row) || null,
			phone: c.agency_phone(row) || null,
		})
		agencyZone ??= c.agency_timezone(row) || null
	})
	if (!hasAgency) warnings.add("agency.txt is missing")
	const soleAgency = agencies.length === 1 ? agencies[0]!.externalId : null

	let timezone = options.feedTimezone ?? agencyZone ?? options.cityTimezone
	if (!validZone(timezone)) {
		warnings.add(`unknown time zone ${timezone}; using ${options.cityTimezone}`)
		timezone = options.cityTimezone
	}
	let shiftS = 0
	if (timezone !== options.cityTimezone) {
		const nowS = options.nowS ?? Math.floor(Date.now() / 1000)
		shiftS = zoneOffsetS(options.cityTimezone, nowS) - zoneOffsetS(timezone, nowS)
		if (shiftS)
			warnings.add(
				`feed time zone ${timezone} differs from ${options.cityTimezone}; start times shifted by ${shiftS} s`,
			)
	}

	// routes.txt
	const agencyFilter = new Set(options.agencyIds ?? [])
	const typeFilter = new Set(options.routeTypes ?? [])
	const routes = new Map<string, StaticRoute & { order: number }>()
	const routeCols = [
		"route_id",
		"agency_id",
		"route_short_name",
		"route_long_name",
		"route_type",
		"route_color",
		"route_text_color",
		"route_sort_order",
	] as const
	const routeCache = {}
	const hasRoutes = await readFile(source, "routes.txt", encoding, (row, table) => {
		const c = columns(table, routeCols, routeCache)
		const id = c.route_id(row)
		if (!id) return warnings.count("routes without route_id skipped")
		const agency = c.agency_id(row) || soleAgency || null
		if (agencyFilter.size && !(agency && agencyFilter.has(agency))) return
		const rawType = Number(c.route_type(row) || 3)
		const routeType = basicRouteType(Number.isFinite(rawType) ? rawType : 3)
		if (typeFilter.size && !typeFilter.has(rawType) && !typeFilter.has(routeType)) return
		const short = c.route_short_name(row)
		const long = c.route_long_name(row)
		if (routes.has(id)) return warnings.count("duplicate route rows skipped")
		const sort = Number(c.route_sort_order(row))
		routes.set(id, {
			externalId: id,
			shortName: short || long || id,
			longName: long || short || id,
			routeType,
			color: parseGtfsColour(c.route_color(row)),
			textColor: parseGtfsColour(c.route_text_color(row)),
			agencyExternalId: agency,
			isPublic: true,
			sort: c.route_sort_order(row) && Number.isFinite(sort) ? sort : routes.size,
			order: routes.size,
		})
	})
	if (!hasRoutes) throw new GtfsFeedError("routes.txt is missing")

	// stops.txt (boarding locations only; stations, entrances and nodes are skipped)
	const stopIndex = new Map<string, number>()
	const stops: StaticStop[] = []
	const stopCols = [
		"stop_id",
		"stop_code",
		"stop_name",
		"stop_lat",
		"stop_lon",
		"location_type",
		"wheelchair_boarding",
	] as const
	const stopCache = {}
	const hasStops = await readFile(source, "stops.txt", encoding, (row, table) => {
		const c = columns(table, stopCols, stopCache)
		const id = c.stop_id(row)
		const locationType = c.location_type(row)
		if (!id || (locationType !== "" && locationType !== "0")) return
		const lat = Number(c.stop_lat(row))
		const lon = Number(c.stop_lon(row))
		if (!c.stop_lat(row) || !c.stop_lon(row) || !Number.isFinite(lat) || !Number.isFinite(lon))
			return warnings.count("stops without coordinates skipped")
		if (stopIndex.has(id)) return warnings.count("duplicate stop rows skipped")
		const wheelchair = Number(c.wheelchair_boarding(row))
		stopIndex.set(id, stops.length)
		stops.push({
			externalId: id,
			name: c.stop_name(row) || c.stop_code(row) || id,
			code: c.stop_code(row) || null,
			lat,
			lon,
			wheelchair: c.wheelchair_boarding(row) && wheelchair >= 0 ? wheelchair : null,
		})
	})
	if (!hasStops) throw new GtfsFeedError("stops.txt is missing")

	// calendar.txt and calendar_dates.txt
	const services = new Map<string, StaticService>()
	const calendarCols = [...WEEKDAY_COLUMNS, "service_id", "start_date", "end_date"] as const
	const calendarCache = {}
	const hasCalendar = await readFile(source, "calendar.txt", encoding, (row, table) => {
		const c = columns(table, calendarCols, calendarCache)
		const id = c.service_id(row)
		if (!id) return
		let mask = 0
		WEEKDAY_COLUMNS.forEach((day, i) => {
			if (c[day](row) === "1") mask |= 1 << i
		})
		services.set(id, {
			externalId: id,
			daysMask: mask,
			label: daysLabel(mask),
			startDate: parseGtfsDate(c.start_date(row)),
			endDate: parseGtfsDate(c.end_date(row)),
			addedDates: [],
			removedDates: [],
		})
	})
	const datesCols = ["service_id", "date", "exception_type"] as const
	const datesCache = {}
	const hasDates = await readFile(source, "calendar_dates.txt", encoding, (row, table) => {
		const c = columns(table, datesCols, datesCache)
		const id = c.service_id(row)
		const date = parseGtfsDate(c.date(row))
		const type = c.exception_type(row)
		if (!id || !date || (type !== "1" && type !== "2"))
			return warnings.count("invalid calendar_dates rows skipped")
		let service = services.get(id)
		if (!service) {
			// calendar_dates-only service: runs exactly on its added dates.
			service = {
				externalId: id,
				daysMask: 0,
				label: null,
				startDate: null,
				endDate: null,
				addedDates: [],
				removedDates: [],
			}
			services.set(id, service)
		}
		;(type === "1" ? service.addedDates! : service.removedDates!).push(date)
	})
	if (!hasCalendar && !hasDates)
		throw new GtfsFeedError("calendar.txt and calendar_dates.txt are both missing")

	// trips.txt
	const trips = new Map<string, TripInfo>()
	const tripCols = [
		"route_id",
		"service_id",
		"trip_id",
		"trip_headsign",
		"direction_id",
		"shape_id",
	] as const
	const tripCache = {}
	const hasTrips = await readFile(source, "trips.txt", encoding, (row, table) => {
		const c = columns(table, tripCols, tripCache)
		const id = c.trip_id(row)
		const routeId = c.route_id(row)
		if (!id || !routes.has(routeId)) return
		const serviceId = c.service_id(row)
		if (!services.has(serviceId)) return warnings.count("trips with an unknown service skipped")
		if (trips.has(id)) return warnings.count("duplicate trip rows skipped")
		trips.set(id, {
			routeId,
			serviceId,
			headsign: c.trip_headsign(row),
			direction: c.direction_id(row) === "1" ? 1 : 0,
			shapeId: c.shape_id(row),
		})
	})
	if (!hasTrips) throw new GtfsFeedError("trips.txt is missing")

	// stop_times.txt
	const times = new Map<string, TripTimes>()
	const stopTimeCols = [
		"trip_id",
		"stop_id",
		"stop_sequence",
		"arrival_time",
		"departure_time",
	] as const
	const stopTimeCache = {}
	const hasStopTimes = await readFile(source, "stop_times.txt", encoding, (row, table) => {
		const c = columns(table, stopTimeCols, stopTimeCache)
		const tripId = c.trip_id(row)
		if (!trips.has(tripId)) return
		const stop = stopIndex.get(c.stop_id(row))
		if (stop === undefined) return warnings.count("stop_times rows with an unknown stop skipped")
		const seq = Number(c.stop_sequence(row))
		if (!c.stop_sequence(row) || !Number.isFinite(seq))
			return warnings.count("stop_times rows without stop_sequence skipped")
		const raw = c.departure_time(row) || c.arrival_time(row)
		const time = raw ? parseGtfsTime(raw) : null
		if (raw && time === null) warnings.count("stop_times rows with an invalid time")
		let entry = times.get(tripId)
		if (!entry) {
			entry = { seq: [], stop: [], time: [] }
			times.set(tripId, entry)
		}
		entry.seq.push(seq)
		entry.stop.push(stop)
		entry.time.push(time ?? Number.NaN)
	})
	if (!hasStopTimes) throw new GtfsFeedError("stop_times.txt is missing")

	// frequencies.txt (headway-based trips become one trip per departure)
	const frequencies = new Map<string, { start: number; end: number; headway: number }[]>()
	const freqCols = ["trip_id", "start_time", "end_time", "headway_secs"] as const
	const freqCache = {}
	await readFile(source, "frequencies.txt", encoding, (row, table) => {
		const c = columns(table, freqCols, freqCache)
		const tripId = c.trip_id(row)
		if (!trips.has(tripId)) return
		const start = parseGtfsTime(c.start_time(row))
		const end = parseGtfsTime(c.end_time(row))
		const headway = Number(c.headway_secs(row))
		if (start === null || end === null || !(headway > 0) || end <= start)
			return warnings.count("invalid frequencies rows skipped")
		const list = frequencies.get(tripId) ?? []
		list.push({ start, end, headway })
		frequencies.set(tripId, list)
	})

	// shapes.txt (only shapes that a kept trip uses)
	const wantedShapes = new Set<string>()
	for (const [id, trip] of trips) if (trip.shapeId && times.has(id)) wantedShapes.add(trip.shapeId)
	const shapePoints = new Map<string, { seq: number; lat: number; lon: number }[]>()
	const shapeCols = ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"] as const
	const shapeCache = {}
	const hasShapes = await readFile(source, "shapes.txt", encoding, (row, table) => {
		const c = columns(table, shapeCols, shapeCache)
		const id = c.shape_id(row)
		if (!wantedShapes.has(id)) return
		const lat = Number(c.shape_pt_lat(row))
		const lon = Number(c.shape_pt_lon(row))
		const seq = Number(c.shape_pt_sequence(row))
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seq))
			return warnings.count("invalid shapes rows skipped")
		const list = shapePoints.get(id) ?? []
		list.push({ seq, lat, lon })
		shapePoints.set(id, list)
	})
	if (!hasShapes && wantedShapes.size)
		warnings.add("shapes.txt is missing; shapes follow the stops")

	const shapes = new Map<string, [number, number][]>()
	for (const [id, points] of shapePoints) {
		points.sort((a, b) => a.seq - b.seq)
		if (points.length >= 2)
			shapes.set(
				id,
				points.map((p) => [p.lat, p.lon]),
			)
	}

	// ---------- patterns ----------

	interface PatternAcc {
		routeId: string
		direction: 0 | 1
		stops: number[]
		offsets: (number | null)[]
		shapeId: string
		headsigns: Map<string, number>
		trips: { tripId: string; info: TripInfo; startS: number[] }[]
	}
	const patterns = new Map<string, PatternAcc>()
	let tripsWithoutTimes = 0
	let tripsTooShort = 0
	for (const [tripId, info] of trips) {
		const entry = times.get(tripId)
		if (!entry || entry.seq.length < 2) {
			tripsTooShort++
			continue
		}
		const order = entry.seq.map((_, i) => i)
		order.sort((a, b) => entry.seq[a]! - entry.seq[b]!)
		const stopList = order.map((i) => entry.stop[i]!)
		const raw = order.map((i) => entry.time[i]!)
		const timed = interpolate(raw, stopList, stops)
		const first = timed[0]
		if (first === null || first === undefined) {
			tripsWithoutTimes++
			continue
		}
		const offsets = timed.map((t) => (t === null ? null : t - first))
		const shapeId = info.shapeId && shapes.has(info.shapeId) ? info.shapeId : ""
		const key = `${info.routeId}\u0000${info.direction}\u0000${shapeId}\u0000${stopList.join(",")}\u0000${offsets.join(",")}`
		let pattern = patterns.get(key)
		if (!pattern) {
			pattern = {
				routeId: info.routeId,
				direction: info.direction,
				stops: stopList,
				offsets,
				shapeId,
				headsigns: new Map(),
				trips: [],
			}
			patterns.set(key, pattern)
		}
		if (info.headsign)
			pattern.headsigns.set(info.headsign, (pattern.headsigns.get(info.headsign) ?? 0) + 1)
		const freq = frequencies.get(tripId)
		const starts: number[] = []
		if (freq) {
			for (const f of freq) for (let t = f.start; t < f.end; t += f.headway) starts.push(t)
		} else starts.push(first)
		pattern.trips.push({ tripId, info, startS: starts })
	}
	if (tripsTooShort) warnings.count("trips with fewer than two stop_times skipped", tripsTooShort)
	if (tripsWithoutTimes)
		warnings.count("trips without a first departure time skipped", tripsWithoutTimes)

	// Stable pattern ids: per route and direction, busiest first, then by key.
	const grouped = new Map<string, [string, PatternAcc][]>()
	for (const entry of patterns) {
		const group = `${entry[1].routeId}\u0000${entry[1].direction}`
		const list = grouped.get(group) ?? []
		list.push(entry)
		grouped.set(group, list)
	}
	const outPatterns: StaticPattern[] = []
	const outTrips: StaticTrip[] = []
	const usedServices = new Set<string>()
	let shapeFallbacks = 0
	for (const list of grouped.values()) {
		list.sort((a, b) => b[1].trips.length - a[1].trips.length || compare(a[0], b[0]))
		list.forEach(([, p], n) => {
			const externalId = `${p.routeId}:${p.direction}:${n + 1}`
			const headsign =
				[...p.headsigns].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0] ??
				stops[p.stops[p.stops.length - 1]!]!.name
			const shape = p.shapeId
				? shapes.get(p.shapeId)!
				: p.stops.map((s): [number, number] => [stops[s]!.lat, stops[s]!.lon])
			if (!p.shapeId) shapeFallbacks++
			outPatterns.push({
				externalId,
				routeExternalId: p.routeId,
				direction: p.direction,
				headsign,
				shape,
				stops: p.stops.map((s, i) => ({
					stopExternalId: stops[s]!.externalId,
					offsetS: p.offsets[i] ?? null,
				})),
			})
			for (const trip of p.trips) {
				usedServices.add(trip.info.serviceId)
				for (const start of trip.startS) {
					outTrips.push({
						// Headway trips get one id per departure, like GTFS-RT trip_id + start_time.
						externalId: frequencies.has(trip.tripId)
							? `${trip.tripId}@${start}`
							: trip.tripId,
						patternExternalId: externalId,
						serviceExternalId: trip.info.serviceId,
						startTimeS: start + shiftS,
						headsign: trip.info.headsign || null,
					})
				}
			}
		})
	}
	if (shapeFallbacks) warnings.count("patterns without a shape use their stops", shapeFallbacks)
	outTrips.sort(
		(a, b) =>
			compare(a.patternExternalId, b.patternExternalId) ||
			a.startTimeS - b.startTimeS ||
			compare(a.externalId, b.externalId),
	)

	const outServices = [...services.values()]
		.filter((s) => usedServices.has(s.externalId))
		.map((s) => ({
			...s,
			addedDates: [...new Set(s.addedDates)].sort(),
			removedDates: [...new Set(s.removedDates)].sort(),
		}))

	const routeList = [...routes.values()]
		.sort((a, b) => a.order - b.order)
		.map(({ order: _order, ...route }) => route)
	const usedAgencies = new Set(routeList.map((r) => r.agencyExternalId))
	return {
		agencies: agencies.filter((a) => usedAgencies.has(a.externalId)),
		routes: routeList,
		stops,
		services: outServices,
		patterns: outPatterns,
		trips: outTrips,
		warnings: warnings.finish(),
		timezone,
	}
}

/**
 * Fills missing times between timed stops in proportion to straight-line distance (equal steps
 * when stops coincide) and keeps times from running backwards. Leading and trailing gaps stay
 * null.
 */
export function interpolate(
	raw: number[],
	stopList: number[],
	stops: { lat: number; lon: number }[],
): (number | null)[] {
	const out: (number | null)[] = raw.map((t) => (Number.isNaN(t) ? null : t))
	let last = -1
	for (let i = 0; i < out.length; i++) {
		if (out[i] === null) continue
		if (last >= 0 && out[i]! < out[last]!) out[i] = out[last]!
		if (last >= 0 && i - last > 1) {
			const dist: number[] = [0]
			for (let k = last + 1; k <= i; k++) {
				const a = stops[stopList[k - 1]!]!
				const b = stops[stopList[k]!]!
				dist.push(dist[dist.length - 1]! + haversineM(a.lat, a.lon, b.lat, b.lon))
			}
			const total = dist[dist.length - 1]!
			const span = out[i]! - out[last]!
			for (let k = last + 1; k < i; k++) {
				const frac = total > 0 ? dist[k - last]! / total : (k - last) / (i - last)
				out[k] = Math.round(out[last]! + span * frac)
			}
		}
		last = i
	}
	return out
}
