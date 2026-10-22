// transit.service.ts
// Public transit reads over the active static versions: routes, stops, shapes, timetables,
// nearby and search. Ids on the wire are stable public ids (`<binding>.<external>`).

import { Injectable } from "@nestjs/common"
import { GezcezError } from "@common/errors"
import { modeOf } from "@common/models/transit.models"
import type { PageQuery } from "@common/response"
import {
	addDays,
	cellsAround,
	clockLabel,
	decodeCursor,
	decodePolyline,
	fromE6,
	ftsQuery,
	haversineM,
	localTime,
	pageFrom,
	parsePublicRef,
	publicRef,
	weekdayBit,
	weekdayOfDate,
	type BBox,
} from "@common/utils"
import type { NetworkRow } from "@schemas/core"
import type { PatternRow, RouteRow, ServiceRow, StopRow } from "@schemas/transit"
import { NetworksService } from "@services/networks/networks.service"
import { TransitRepository, type ActiveVersion } from "./transit.repository"

export interface RouteSummary {
	id: string
	network_id: number
	short_name: string
	long_name: string
	mode: ReturnType<typeof modeOf>
	route_type: number
	colour: string | null
	text_colour: string | null
	agency: string | null
}

export interface StopSummary {
	id: string
	network_id: number
	name: string
	code: string | null
	lat: number
	lon: number
}

export type DayType = "weekday" | "saturday" | "sunday"
const DAY_TYPE_WEEKDAY: Record<DayType, number> = { weekday: 0, saturday: 5, sunday: 6 }

export interface ResolvedRoute {
	route: RouteRow
	version: ActiveVersion
	network: NetworkRow
}

export interface ResolvedStop {
	stop: StopRow
	version: ActiveVersion
	network: NetworkRow
}

/** A version together with the network it serves (one per binding). */
interface NetworkVersion extends ActiveVersion {
	network_id: number
}

@Injectable()
export class TransitService {
	private agencyNames = new Map<number, string | null>()

	constructor(
		private readonly repository: TransitRepository,
		private readonly networks: NetworksService,
	) {}

	// ---------- versions ----------

	/** Active versions of the bindings of a network (bindings of killed providers included). */
	networkVersions(networkId: number): NetworkVersion[] {
		return this.networks.bindings(networkId).flatMap((binding) => {
			const version = this.repository.activeVersion(binding.id)
			return version ? [{ ...version, network_id: networkId }] : []
		})
	}

	versionOfBinding(bindingId: number): ActiveVersion | undefined {
		return this.repository.activeVersion(bindingId)
	}

	modes(versionIds: number[]): ReturnType<typeof modeOf>[] {
		return [...new Set(this.repository.routeTypes(versionIds).map(modeOf))].sort()
	}

	/** Public network that owns a binding, or NOT_FOUND. */
	private publicNetworkOfBinding(bindingId: number): NetworkRow {
		const binding = this.networks.bindings().find((b) => b.id === bindingId)
		if (!binding) throw new GezcezError("NOT_FOUND")
		return this.networks.network(String(binding.network_id))
	}

	// ---------- shaping ----------

	private agencyName(id: number | null): string | null {
		if (id === null) return null
		if (!this.agencyNames.has(id))
			this.agencyNames.set(id, this.repository.agency(id)?.name ?? null)
		return this.agencyNames.get(id) ?? null
	}

	routeSummary(route: RouteRow, networkId: number): RouteSummary {
		return {
			id: publicRef(route.binding_id, route.external_id),
			network_id: networkId,
			short_name: route.short_name,
			long_name: route.long_name,
			mode: modeOf(route.route_type),
			route_type: route.route_type,
			colour: route.color,
			text_colour: route.text_color,
			agency: this.agencyName(route.agency_id),
		}
	}

	stopSummary(stop: StopRow, networkId: number): StopSummary {
		return {
			id: publicRef(stop.binding_id, stop.external_id),
			network_id: networkId,
			name: stop.name,
			code: stop.code,
			lat: fromE6(stop.lat_e6),
			lon: fromE6(stop.lon_e6),
		}
	}

	// ---------- resolution ----------

	resolveRoute(routeId: string): ResolvedRoute {
		const ref = parsePublicRef(routeId)
		if (!ref) throw new GezcezError("NOT_FOUND", "Route not found")
		const network = this.publicNetworkOfBinding(ref.bindingId)
		const version = this.repository.activeVersion(ref.bindingId)
		const route = version && this.repository.route(version.version_id, ref.externalId)
		if (!version || !route || !route.is_public)
			throw new GezcezError("NOT_FOUND", "Route not found")
		return { route, version, network }
	}

	resolveStop(stopId: string): ResolvedStop {
		const ref = parsePublicRef(stopId)
		if (!ref) throw new GezcezError("NOT_FOUND", "Stop not found")
		const network = this.publicNetworkOfBinding(ref.bindingId)
		const version = this.repository.activeVersion(ref.bindingId)
		const stop = version && this.repository.stop(version.version_id, ref.externalId)
		if (!version || !stop) throw new GezcezError("NOT_FOUND", "Stop not found")
		return { stop, version, network }
	}

	// ---------- routes ----------

	listRoutes(
		networkRef: string,
		query: { type?: number; q?: string; limit?: number; cursor?: string },
	) {
		const network = this.networks.network(networkRef)
		const versions = this.networkVersions(network.id)
		const filters = { n: network.id, type: query.type, q: query.q ?? null }
		const offset = decodeCursor(query.cursor, filters)
		const rows = this.repository.routes(versions, {
			routeType: query.type,
			q: query.q,
			limit: query.limit !== undefined ? query.limit + 1 : undefined,
			offset,
		})
		const items = rows.map((r) => this.routeSummary(r, network.id))
		if (query.limit === undefined)
			return { items, next_cursor: null, prev_cursor: null, total: items.length }
		const total =
			query.type === undefined && !query.q
				? this.repository.countRoutes(versions.map((v) => v.version_id))
				: null
		return pageFrom(items, offset, query.limit, filters, total)
	}

	private patternStopsOf(patterns: PatternRow[], networkId: number) {
		const rows = this.repository.patternStops(patterns.map((p) => p.id))
		const byPattern = new Map<number, typeof rows>()
		for (const row of rows) {
			const list = byPattern.get(row.pattern_id) ?? []
			list.push(row)
			byPattern.set(row.pattern_id, list)
		}
		return (pattern: PatternRow, bindingId: number) =>
			(byPattern.get(pattern.id) ?? []).map((s) => ({
				id: publicRef(bindingId, s.stop_external_id),
				network_id: networkId,
				name: s.stop_name,
				lat: fromE6(s.lat_e6),
				lon: fromE6(s.lon_e6),
				seq: s.seq,
				offset_s: s.offset_s,
			}))
	}

	routeDetail(routeId: string) {
		const { route, network } = this.resolveRoute(routeId)
		const patterns = this.repository.patternsForRoute(route.id)
		const stopsOf = this.patternStopsOf(patterns, network.id)
		const directions = [0, 1]
			.map((direction) => {
				const list = patterns.filter((p) => p.direction === direction)
				return {
					direction,
					headsign: list[0]?.headsign ?? null,
					patterns: list.map((p) => ({
						id: p.external_ref,
						headsign: p.headsign,
						length_m: p.length_m,
						stops: stopsOf(p, route.binding_id),
					})),
				}
			})
			.filter((d) => d.patterns.length)
		return { ...this.routeSummary(route, network.id), directions }
	}

	routeShape(routeId: string, direction?: number) {
		const { route } = this.resolveRoute(routeId)
		const patterns = this.repository.patternsForRoute(route.id, direction)
		return {
			route_id: publicRef(route.binding_id, route.external_id),
			precision: 6,
			shapes: patterns.map((p) => ({
				direction: p.direction,
				pattern_id: p.external_ref,
				polyline: p.shape,
			})),
		}
	}

	/** Services active on a local date (weekday mask; manual exceptions come later). */
	private servicesOn(services: ServiceRow[], weekday: number): ServiceRow[] {
		const bit = weekdayBit(weekday)
		return services.filter((s) => (s.days_mask & bit) !== 0)
	}

	routeTimetable(
		routeId: string,
		query: { direction?: number; date?: string; day_type?: DayType },
	) {
		const { route, version, network } = this.resolveRoute(routeId)
		const timezone = this.networks.cityById(network.city_id)?.timezone ?? "Europe/Istanbul"
		const date =
			query.date ??
			(query.day_type ? null : localTime(Math.floor(Date.now() / 1000), timezone).date)
		const weekday = date ? weekdayOfDate(date) : DAY_TYPE_WEEKDAY[query.day_type ?? "weekday"]
		const dayType: DayType = weekday === 6 ? "sunday" : weekday === 5 ? "saturday" : "weekday"
		const services = this.servicesOn(this.repository.services(version.version_id), weekday)
		const patterns = this.repository.patternsForRoute(route.id, query.direction)
		const stopsOf = this.patternStopsOf(patterns, 0)
		const trips = this.repository.tripsForPatterns(
			patterns.map((p) => p.id),
			services.map((s) => s.id),
		)
		return {
			route_id: publicRef(route.binding_id, route.external_id),
			date,
			day_type: dayType,
			service_labels: services.map((s) => s.label).filter((l): l is string => Boolean(l)),
			patterns: patterns.map((p) => ({
				id: p.external_ref,
				direction: p.direction,
				headsign: p.headsign,
				stops: stopsOf(p, route.binding_id).map((s) => ({
					id: s.id,
					name: s.name,
					offset_s: s.offset_s,
				})),
				departures: trips
					.filter((t) => t.pattern_id === p.id)
					.map((t) => ({
						trip_id: t.external_id,
						start: clockLabel(t.start_time_s),
						start_s: t.start_time_s,
						headsign: t.headsign,
					})),
			})),
		}
	}

	// ---------- stops ----------

	listStops(networkRef: string, query: PageQuery & { bbox?: BBox }) {
		const network = this.networks.network(networkRef)
		const versions = this.networkVersions(network.id)
		const filters = { n: network.id, bbox: query.bbox ?? null, q: query.q ?? null }
		const offset = decodeCursor(query.cursor, filters)
		const rows = this.repository.stops(versions, {
			bbox: query.bbox,
			q: query.q,
			limit: query.limit + 1,
			offset,
		})
		const total =
			!query.bbox && !query.q
				? this.repository.countStops(versions.map((v) => v.version_id))
				: null
		return pageFrom(
			rows.map((s) => this.stopSummary(s, network.id)),
			offset,
			query.limit,
			filters,
			total,
		)
	}

	private routesServing(stops: StopRow[], networkId: number): Map<number, RouteSummary[]> {
		const pairs = this.repository.routesServingStops(stops.map((s) => s.id))
		const routes = new Map(
			this.repository
				.routesByIds([...new Set(pairs.map((p) => p.route_id))])
				.map((r) => [r.id, r]),
		)
		const result = new Map<number, RouteSummary[]>()
		for (const pair of pairs) {
			const route = routes.get(pair.route_id)
			if (!route || !route.is_public) continue
			const list = result.get(pair.stop_id) ?? []
			list.push(this.routeSummary(route, networkId))
			result.set(pair.stop_id, list)
		}
		for (const list of result.values())
			list.sort((a, b) => a.short_name.localeCompare(b.short_name, "tr", { numeric: true }))
		return result
	}

	stopDetail(stopId: string) {
		const { stop, network } = this.resolveStop(stopId)
		const routes = this.routesServing([stop], network.id).get(stop.id) ?? []
		return { ...this.stopSummary(stop, network.id), routes }
	}

	/**
	 * Nearby stops. Coordinates are rounded to 3 decimals (about 100 m) before use and are never
	 * logged or stored (plan 6.11).
	 */
	nearby(query: { lat: number; lon: number; radius: number; network?: string; limit: number }) {
		const lat = Math.round(query.lat * 1000) / 1000
		const lon = Math.round(query.lon * 1000) / 1000
		const networks = query.network
			? [this.networks.network(query.network)]
			: this.networks.listNetworks({ publicOnly: true })
		const versions = networks.flatMap((n) => this.networkVersions(n.id))
		const networkOfVersion = new Map(versions.map((v) => [v.version_id, v.network_id]))
		const candidates = this.repository
			.stopsInCells(
				versions.map((v) => v.version_id),
				cellsAround(lat, lon, query.radius),
			)
			.map((stop) => ({
				stop,
				distance: haversineM(lat, lon, fromE6(stop.lat_e6), fromE6(stop.lon_e6)),
			}))
			.filter((c) => c.distance <= query.radius)
			.sort((a, b) => a.distance - b.distance)
			.slice(0, query.limit)
		const byNetwork = new Map<number, StopRow[]>()
		for (const c of candidates) {
			const networkId = networkOfVersion.get(c.stop.version_id)!
			byNetwork.set(networkId, [...(byNetwork.get(networkId) ?? []), c.stop])
		}
		const serving = new Map<number, RouteSummary[]>()
		for (const [networkId, stops] of byNetwork)
			for (const [id, list] of this.routesServing(stops, networkId)) serving.set(id, list)
		return {
			items: candidates.map((c) => ({
				...this.stopSummary(c.stop, networkOfVersion.get(c.stop.version_id)!),
				distance_m: Math.round(c.distance),
				route_ids: (serving.get(c.stop.id) ?? []).map((r) => r.id),
			})),
		}
	}

	// ---------- search ----------

	search(query: { q: string; city?: string; network?: string; limit: number }) {
		let networks: NetworkRow[]
		if (query.network) networks = [this.networks.network(query.network)]
		else if (query.city) {
			const city = this.networks.city(query.city)
			networks = this.networks.listNetworks({ cityId: city.id, publicOnly: true })
		} else networks = this.networks.listNetworks({ publicOnly: true })
		const versions = networks.flatMap((n) => this.networkVersions(n.id))
		const match = ftsQuery(query.q)
		if (!match || !versions.length) return { routes: [], stops: [] }
		const hits = this.repository.search(
			versions.map((v) => v.version_id),
			match,
			query.limit * 2,
		)
		const versionOf = new Map(versions.map((v) => [v.binding_id, v]))
		const routes: RouteSummary[] = []
		const stops: StopSummary[] = []
		for (const hit of hits) {
			const version = versionOf.get(hit.binding_id)
			if (!version) continue
			if (hit.kind === "route" && routes.length < query.limit) {
				const route = this.repository.route(version.version_id, hit.ref_id)
				if (route?.is_public) routes.push(this.routeSummary(route, version.network_id))
			} else if (hit.kind === "stop" && stops.length < query.limit) {
				const stop = this.repository.stop(version.version_id, hit.ref_id)
				if (stop) stops.push(this.stopSummary(stop, version.network_id))
			}
		}
		return { routes, stops }
	}

	// ---------- helpers for departures and the tracker ----------

	patternShape(pattern: PatternRow): [number, number][] {
		return decodePolyline(pattern.shape)
	}

	/** Local dates to look at for departures around `nowS` (yesterday for after-midnight trips). */
	serviceDates(nowS: number, timezone: string): { date: string; weekday: number }[] {
		const today = localTime(nowS, timezone).date
		return [addDays(today, -1), today].map((date) => ({ date, weekday: weekdayOfDate(date) }))
	}
}
