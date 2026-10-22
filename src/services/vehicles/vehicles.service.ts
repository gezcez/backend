// vehicles.service.ts
// Live vehicles for riders and the dashboard (plan 6.10 and 6.11): the shared subscription filter
// (network, routes, direction, bbox snapped to z12), compact/full arrays, the REST snapshot,
// vehicle detail, departures (schedule merged with live vehicles) and observed departures.

import { Inject, Injectable } from "@nestjs/common"
import { BEARER_AUTH, type BearerAuthProvider } from "@common/auth.types"
import { hasPermission, PERMISSION_RESOLVER, type PermissionResolver } from "@common/authorization"
import { GezcezError } from "@common/errors"
import {
	VEHICLE_FIELDS_COMPACT,
	VEHICLE_FIELDS_FULL,
	VEHICLE_FLAGS,
} from "@common/models/transit.models"
import {
	type BBox,
	addDays,
	clockLabel,
	fromE6,
	inBBox,
	localTime,
	parsePublicRef,
	publicRef,
	serviceDayStart,
	snapBBoxToTiles,
	weekdayBit,
	weekdayOfDate,
	zonedInstant,
} from "@common/utils"
import type { NetworkRow } from "@schemas/core"
import type { PatternRow, RouteRow } from "@schemas/transit"
import type { TripRunRow } from "@schemas/vts"
import { NetworksService } from "@services/networks/networks.service"
import { LiveFeedBus } from "@services/tracker/live-feed.bus"
import { TrackerHostService } from "@services/tracker/tracker-host.service"
import { TrackerRepository } from "@services/tracker/tracker.repository"
import { TrackerTimetable } from "@services/tracker/tracker-timetable"
import type { LiveVehicle } from "@services/tracker/tracker.types"
import { TransitRepository } from "@services/transit/transit.repository"
import { TransitService } from "@services/transit/transit.service"

export const MAX_ROUTES_PER_SUB = 12
export const MAX_BBOX_SPAN_DEG = 0.5
export const MAX_VEHICLES_PER_NETWORK = 3000
const STALE_S = 180
const DEPARTURE_HORIZON_S = 3 * 3600
const DEPARTURE_PAST_S = 60
const LIVE_MATCH_WINDOW_S = 20 * 60

export type VehicleDetail = "compact" | "full"
export type VehicleRowValues = (string | number | null)[]

export interface VehicleFilterParams {
	network: string
	routes?: string[]
	direction?: 0 | 1
	bbox?: BBox
}

/** A resolved subscription filter; equal params produce equal keys (shared server filters). */
export interface VehicleFilter {
	network: NetworkRow
	bindingIds: Set<number>
	/** `${binding_id}|${route_ext}` keys, or null for every route. */
	routes: Set<string> | null
	direction: 0 | 1 | null
	bbox: BBox | null
	key: string
}

function round(value: number, digits: number): number {
	const f = 10 ** digits
	return Math.round(value * f) / f
}

function iso(ts: number | null | undefined): string | null {
	return ts === null || ts === undefined ? null : new Date(ts * 1000).toISOString()
}

@Injectable()
export class VehiclesService {
	constructor(
		private readonly networks: NetworksService,
		private readonly bus: LiveFeedBus,
		private readonly host: TrackerHostService,
		private readonly tracker: TrackerRepository,
		private readonly timetable: TrackerTimetable,
		private readonly transitRepo: TransitRepository,
		private readonly transit: TransitService,
		@Inject(BEARER_AUTH) private readonly bearer: BearerAuthProvider,
		@Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
	) {}

	// ---- filters ------------------------------------------------------------------------------

	/** Validates and resolves subscription params (throws VALIDATION_FAILED / NOT_FOUND). */
	filter(params: VehicleFilterParams): VehicleFilter {
		const network = this.networks.network(params.network)
		const bindingIds = new Set(this.networks.bindings(network.id).map((b) => b.id))
		let routes: Set<string> | null = null
		if (params.routes?.length) {
			if (params.routes.length > MAX_ROUTES_PER_SUB)
				throw new GezcezError("VALIDATION_FAILED", `At most ${MAX_ROUTES_PER_SUB} routes`)
			routes = new Set()
			for (const id of params.routes) {
				const ref = parsePublicRef(id)
				if (!ref || !bindingIds.has(ref.bindingId))
					throw new GezcezError("VALIDATION_FAILED", `Unknown route ${id}`)
				routes.add(`${ref.bindingId}|${ref.externalId}`)
			}
		}
		let bbox: BBox | null = null
		if (params.bbox) {
			const [w, s, e, n] = params.bbox
			if (!(w < e && s < n) || e - w > MAX_BBOX_SPAN_DEG || n - s > MAX_BBOX_SPAN_DEG)
				throw new GezcezError(
					"VALIDATION_FAILED",
					`bbox must be [w,s,e,n] with at most ${MAX_BBOX_SPAN_DEG} degree span`,
				)
			bbox = snapBBoxToTiles(params.bbox, 12)
		}
		const direction = params.direction ?? null
		const key = [
			network.id,
			routes ? [...routes].sort().join(",") : "*",
			direction ?? "*",
			bbox ? bbox.map((v) => v.toFixed(6)).join(",") : "*",
		].join(";")
		return { network, bindingIds, routes, direction, bbox, key }
	}

	matches(filter: VehicleFilter, v: LiveVehicle): boolean {
		if (!filter.bindingIds.has(v.binding_id)) return false
		if (filter.routes && !filter.routes.has(`${v.binding_id}|${v.route_ext ?? ""}`))
			return false
		if (filter.direction !== null && v.direction !== filter.direction) return false
		if (filter.bbox && !inBBox(fromE6(v.lat_e6), fromE6(v.lon_e6), filter.bbox)) return false
		return true
	}

	fields(detail: VehicleDetail): readonly string[] {
		return detail === "full" ? VEHICLE_FIELDS_FULL : VEHICLE_FIELDS_COMPACT
	}

	flags(v: LiveVehicle): number {
		let flags = 0
		if (v.feed_ts - v.vehicle_ts > STALE_S) flags |= VEHICLE_FLAGS.stale
		if (v.route_ext && v.stop_seq !== null) {
			const length = this.timetable.patternLength(v.binding_id, v.route_ext, v.direction)
			if (length !== undefined && v.stop_seq >= length) flags |= VEHICLE_FLAGS.at_terminus
		}
		return flags
	}

	/** One vehicle in the 6.10 array order. */
	row(v: LiveVehicle, detail: VehicleDetail): VehicleRowValues {
		const values: VehicleRowValues = [
			publicRef(v.binding_id, v.external_id),
			round(fromE6(v.lat_e6), 5),
			round(fromE6(v.lon_e6), 5),
			v.bearing_d10 === null ? null : Math.round(v.bearing_d10 / 10),
			v.speed_cms === null ? null : round(v.speed_cms / 100, 1),
			v.route_ext ? publicRef(v.binding_id, v.route_ext) : null,
			v.direction,
			v.trip_ext ? publicRef(v.binding_id, v.trip_ext) : null,
			v.stop_seq,
			v.status,
			v.vehicle_ts,
			this.flags(v),
		]
		if (detail === "full")
			values.push(v.plate, v.stop_ext ? publicRef(v.binding_id, v.stop_ext) : null, v.label)
		return values
	}

	/** Vehicles matching a filter, capped per network. */
	select(filter: VehicleFilter): LiveVehicle[] {
		const out: LiveVehicle[] = []
		for (const bindingId of filter.bindingIds) {
			for (const v of this.bus.vehicles(bindingId)) {
				if (this.matches(filter, v)) out.push(v)
				if (out.length >= MAX_VEHICLES_PER_NETWORK) return out
			}
		}
		return out
	}

	feedTs(filter: VehicleFilter): number | null {
		let ts: number | null = null
		for (const id of filter.bindingIds) {
			const t = this.bus.lastFeedTs(id)
			if (t !== null && (ts === null || t > ts)) ts = t
		}
		return ts
	}

	networkStatus(network: NetworkRow) {
		const effective = this.networks.effectiveBindings(network.id)
		return {
			...this.networks.networkStatus(effective),
			realtime: effective.some((b) => b.capabilities.realtime_vehicles),
		}
	}

	// ---- REST ---------------------------------------------------------------------------------

	/**
	 * REST snapshot. `full` rows (plate, stop, headsign) need the caller's bearer token with the
	 * dash scope and vehicles.live.read in the network, the same rule as the WS `detail: "full"`.
	 */
	async snapshot(
		params: VehicleFilterParams,
		detail: VehicleDetail = "compact",
		authorization?: string,
	) {
		const filter = this.filter(params)
		if (detail === "full") await this.authorizeFull(authorization, filter.network.id)
		for (const id of filter.bindingIds) this.host.touch(id)
		const status = this.networkStatus(filter.network)
		return {
			network_id: filter.network.id,
			feed_ts: this.feedTs(filter),
			status: status.status,
			message: status.message,
			fields: [...this.fields(detail)],
			vehicles: this.select(filter).map((v) => this.row(v, detail)),
		}
	}

	private async authorizeFull(header: string | undefined, networkId: number): Promise<void> {
		if (!header) throw new GezcezError("AUTH_REQUIRED", "detail=full needs a bearer token")
		const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header)
		if (!match) throw new GezcezError("AUTH_TOKEN_INVALID")
		const auth = await this.bearer.authenticate(match[1]!)
		if (!auth.scopes.includes("dash"))
			throw new GezcezError("SCOPE_MISSING", undefined, { required: ["dash"] })
		if (!hasPermission(this.permissions.forUser(auth.userId), "vehicles.live.read", networkId))
			throw new GezcezError("PERMISSION_MISSING", "Missing vehicles.live.read")
	}

	private publicVehicle(vehicleId: string) {
		const ref = parsePublicRef(vehicleId)
		if (!ref) throw new GezcezError("NOT_FOUND", "Vehicle not found")
		const binding = this.networks.bindings().find((b) => b.id === ref.bindingId)
		if (!binding) throw new GezcezError("NOT_FOUND", "Vehicle not found")
		const network = this.networks.network(String(binding.network_id))
		const row = this.tracker.vehicle(ref.bindingId, ref.externalId)
		if (!row) throw new GezcezError("NOT_FOUND", "Vehicle not found")
		return { ref, network, row }
	}

	private routeOf(bindingId: number, routeExt: string | null, networkId: number) {
		if (!routeExt) return null
		const version = this.transitRepo.activeVersion(bindingId)
		const route = version && this.transitRepo.route(version.version_id, routeExt)
		return route ? this.transit.routeSummary(route, networkId) : null
	}

	private runView(run: TripRunRow, timezone: string) {
		return {
			route_id: run.route_ext ? publicRef(run.binding_id, run.route_ext) : null,
			direction: run.direction,
			trip_id: run.trip_ext ? publicRef(run.binding_id, run.trip_ext) : null,
			started_at: iso(run.started_at)!,
			ended_at: iso(run.ended_at),
			end_reason: run.end_reason,
			first_stop_seq: run.first_stop_seq,
			last_stop_seq: run.last_stop_seq,
			scheduled_start:
				run.scheduled_start_s === null
					? null
					: iso(
							zonedInstant(
								localTime(run.started_at - (run.start_delay_s ?? 0), timezone).date,
								run.scheduled_start_s,
								timezone,
							),
						),
			start_delay_s: run.start_delay_s,
		}
	}

	vehicleDetail(vehicleId: string) {
		const { ref, network, row } = this.publicVehicle(vehicleId)
		this.host.touch(ref.bindingId)
		const timezone = this.networks.cityById(network.city_id)?.timezone ?? "Europe/Istanbul"
		const live = this.bus.vehicle(ref.bindingId, row.id)
		const state = this.tracker.vehicleState(row.id)
		const since = serviceDayStart(Math.floor(Date.now() / 1000), timezone)
		const runs = this.tracker.runsOfVehicle(row.id, since)
		const current = runs.find((r) => r.id === state?.open_run_id && r.ended_at === null)
		return {
			id: publicRef(ref.bindingId, row.external_id),
			network_id: network.id,
			plate: row.plate,
			label: live?.label ?? row.label,
			live: Boolean(live),
			accessible: null,
			last_seen_at: iso(row.last_seen_at)!,
			position: live
				? {
						lat: round(fromE6(live.lat_e6), 5),
						lon: round(fromE6(live.lon_e6), 5),
						bearing:
							live.bearing_d10 === null ? null : Math.round(live.bearing_d10 / 10),
						speed_ms: live.speed_cms === null ? null : round(live.speed_cms / 100, 1),
						vehicle_ts: live.vehicle_ts,
						feed_ts: live.feed_ts,
						stale: (this.flags(live) & VEHICLE_FLAGS.stale) !== 0,
					}
				: null,
			route: live ? this.routeOf(ref.bindingId, live.route_ext, network.id) : null,
			direction: live?.direction ?? null,
			trip_id: live?.trip_ext ? publicRef(ref.bindingId, live.trip_ext) : null,
			stop_id: live?.stop_ext ? publicRef(ref.bindingId, live.stop_ext) : null,
			stop_seq: live?.stop_seq ?? null,
			current_run: current ? this.runView(current, timezone) : null,
			runs_today: runs.map((r) => this.runView(r, timezone)),
		}
	}

	/**
	 * Scheduled departures at a stop merged with live vehicles on the patterns serving it
	 * (plan 6.11). A vehicle counts when its next stop is before this stop on the same pattern;
	 * its ETA is now plus the scheduled offset difference (P3 fallback without segment medians).
	 */
	departures(stopId: string, limit: number, nowS = Math.floor(Date.now() / 1000)) {
		const { stop, version, network } = this.transit.resolveStop(stopId)
		const bindingId = stop.binding_id
		this.host.touch(bindingId)
		const timezone = this.networks.cityById(network.city_id)?.timezone ?? "Europe/Istanbul"
		const visits = this.transitRepo.visitsOfStop(stop.id)
		const patterns = new Map(
			this.transitRepo.patternsByIds(visits.map((v) => v.pattern_id)).map((p) => [p.id, p]),
		)
		const routes = new Map(
			this.transitRepo
				.routesByIds([...new Set([...patterns.values()].map((p) => p.route_id))])
				.map((r) => [r.id, r]),
		)
		const patternStops = this.transitRepo.patternStops([...patterns.keys()])
		const offsets = new Map<string, number>()
		for (const ps of patternStops) offsets.set(`${ps.pattern_id}|${ps.seq}`, ps.offset_s ?? 0)
		const services = this.transitRepo.services(version.version_id)

		interface Item {
			route: RouteRow
			pattern: PatternRow
			headsign: string | null
			tripExt: string | null
			scheduledAt: number | null
			predictedAt: number | null
			vehicleId: string | null
			stopsAway: number | null
			source: "schedule" | "live" | "live_eta"
		}
		const items: Item[] = []
		const today = localTime(nowS, timezone).date
		for (const visit of visits) {
			const pattern = patterns.get(visit.pattern_id)
			const route = pattern && routes.get(pattern.route_id)
			if (!pattern || !route || !route.is_public) continue
			const offset = visit.offset_s ?? 0
			for (const date of [addDays(today, -1), today]) {
				const bit = weekdayBit(weekdayOfDate(date))
				const serviceIds = services
					.filter(
						(s) =>
							(s.days_mask & bit) !== 0 &&
							(!s.start_date || s.start_date <= date) &&
							(!s.end_date || s.end_date >= date),
					)
					.map((s) => s.id)
				const dayStart = zonedInstant(date, 0, timezone)
				const from = nowS - DEPARTURE_PAST_S - dayStart - offset
				const trips = this.transitRepo.tripsForPatterns([pattern.id], serviceIds, {
					from,
					to: from + DEPARTURE_HORIZON_S,
				})
				for (const trip of trips) {
					items.push({
						route,
						pattern,
						headsign: trip.headsign ?? pattern.headsign,
						tripExt: trip.external_id,
						scheduledAt: dayStart + trip.start_time_s + offset,
						predictedAt: null,
						vehicleId: null,
						stopsAway: null,
						source: "schedule",
					})
				}
			}
			// Live vehicles approaching this visit on the same route and direction.
			for (const v of this.bus.vehicles(bindingId)) {
				if (v.route_ext !== route.external_id || v.direction !== pattern.direction) continue
				if (v.stop_seq === null || v.stop_seq > visit.seq) continue
				if (v.feed_ts - v.vehicle_ts > STALE_S) continue
				const vehicleOffset = offsets.get(`${pattern.id}|${v.stop_seq}`)
				if (vehicleOffset === undefined) continue
				const predictedAt = nowS + Math.max(0, offset - vehicleOffset)
				const vehicleRef = publicRef(bindingId, v.external_id)
				const sameRoute = items.filter(
					(i) =>
						i.pattern.id === pattern.id &&
						i.vehicleId === null &&
						i.scheduledAt !== null,
				)
				let match = v.trip_ext ? sameRoute.find((i) => i.tripExt === v.trip_ext) : undefined
				let source: Item["source"] = match ? "live" : "live_eta"
				if (!match) {
					let best: Item | undefined
					for (const i of sameRoute) {
						const gap = Math.abs(i.scheduledAt! - predictedAt)
						if (
							gap <= LIVE_MATCH_WINDOW_S &&
							(!best || gap < Math.abs(best.scheduledAt! - predictedAt))
						)
							best = i
					}
					match = best
					source = "live_eta"
				}
				const target: Item = match ?? {
					route,
					pattern,
					headsign: v.label ?? pattern.headsign,
					tripExt: v.trip_ext,
					scheduledAt: null,
					predictedAt: null,
					vehicleId: null,
					stopsAway: null,
					source,
				}
				target.predictedAt = predictedAt
				target.vehicleId = vehicleRef
				target.stopsAway = visit.seq - v.stop_seq
				target.source = source
				if (!match) items.push(target)
			}
		}
		const at = (i: Item) => i.predictedAt ?? i.scheduledAt ?? Infinity
		const upcoming = items
			.filter((i) => at(i) >= nowS - DEPARTURE_PAST_S)
			.sort((a, b) => at(a) - at(b))
			.slice(0, limit)
		return {
			stop: this.transit.stopSummary(stop, network.id),
			generated_at: iso(nowS)!,
			items: upcoming.map((i) => ({
				route: this.transit.routeSummary(i.route, network.id),
				headsign: i.headsign,
				direction: i.pattern.direction === 1 ? (1 as const) : (0 as const),
				trip_id: i.tripExt ? publicRef(bindingId, i.tripExt) : null,
				scheduled_at: iso(i.scheduledAt),
				predicted_at: iso(i.predictedAt),
				vehicle_id: i.vehicleId,
				stops_away: i.stopsAway,
				source: i.source,
				cancelled: false,
			})),
		}
	}

	/** Observed trip starts on the same weekday last week (FKart VTS observer feature). */
	historyDepartures(routeId: string, query: { direction?: number; weekday?: number }) {
		const { route, network } = this.transit.resolveRoute(routeId)
		const timezone = this.networks.cityById(network.city_id)?.timezone ?? "Europe/Istanbul"
		const nowS = Math.floor(Date.now() / 1000)
		const today = localTime(nowS, timezone)
		const weekday = query.weekday ?? today.weekday
		// The most recent past date with that weekday, at least one day ago, within 7 days.
		let back = (today.weekday - weekday + 7) % 7
		if (back === 0) back = 7
		const date = addDays(today.date, -back)
		const from = zonedInstant(date, 0, timezone)
		const runs = this.tracker.runsOfRoute(
			route.binding_id,
			route.external_id,
			query.direction ?? null,
			from,
			zonedInstant(addDays(date, 1), 0, timezone),
		)
		return {
			route: this.transit.routeSummary(route, network.id),
			date,
			weekday,
			items: runs.map((r) => ({
				started_at: iso(r.started_at)!,
				clock: clockLabel(r.started_at - from),
				direction: r.direction,
				trip_id:
					r.trip_ext && !r.keyed_by_route ? publicRef(r.binding_id, r.trip_ext) : null,
				scheduled_clock:
					r.scheduled_start_s === null ? null : clockLabel(r.scheduled_start_s),
				start_delay_s: r.start_delay_s,
				ended_at: iso(r.ended_at),
				end_reason: r.end_reason,
			})),
		}
	}
}
