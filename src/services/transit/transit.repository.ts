// transit.repository.ts
// All transit.db access: versioned writes from the static sync (with the atomic swap) and the
// read side used by the public transit endpoints. Readers always go through active_versions.

import { Injectable } from "@nestjs/common"
import { and, asc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm"
import { InjectTransitDb, type TransitDatabase } from "@db"
import { encodePolyline, foldTurkish, gridCell, polylineLengthM, toE6 } from "@common/utils"
import {
	activeVersionsTable,
	agenciesTable,
	feedVersionsTable,
	patternStopsTable,
	patternsTable,
	routesTable,
	servicesTable,
	stopsTable,
	syncRunsTable,
	tripsTable,
	type AgencyRow,
	type PatternRow,
	type RouteRow,
	type ServiceRow,
	type StopRow,
	type SyncRunRow,
	type TripRow,
} from "@schemas/transit"
import type {
	StaticAgency,
	StaticPattern,
	StaticRoute,
	StaticService,
	StaticStop,
	StaticTrip,
} from "@services/providers/transit-provider.interface"

export interface StaticBundle {
	agencies: StaticAgency[]
	routes: StaticRoute[]
	stops: StaticStop[]
	patterns: StaticPattern[]
	services: StaticService[]
	trips: StaticTrip[]
}

export interface ActiveVersion {
	binding_id: number
	version_id: number
	activated_at: Date
	source_hash: string | null
}

export interface PatternStopRow {
	pattern_id: number
	seq: number
	offset_s: number | null
	stop_id: number
	stop_external_id: string
	stop_name: string
	lat_e6: number
	lon_e6: number
}

export interface SearchHit {
	kind: "route" | "stop"
	ref_id: string
	binding_id: number
	rank: number
}

@Injectable()
export class TransitRepository {
	constructor(@InjectTransitDb() private readonly db: TransitDatabase) {}

	// ---------- sync runs and versions ----------

	startRun(bindingId: number, trigger: SyncRunRow["trigger"]): number {
		return this.db
			.insert(syncRunsTable)
			.values({ binding_id: bindingId, trigger, started_at: new Date(), status: "running" })
			.returning({ id: syncRunsTable.id })
			.get().id
	}

	finishRun(
		id: number,
		result: Pick<SyncRunRow, "status" | "version_id" | "counts" | "warnings" | "error">,
	): void {
		this.db
			.update(syncRunsTable)
			.set({ ...result, finished_at: new Date() })
			.where(eq(syncRunsTable.id, id))
			.run()
	}

	listRuns(bindingIds: number[], limit: number, offset: number): SyncRunRow[] {
		if (!bindingIds.length) return []
		return this.db
			.select()
			.from(syncRunsTable)
			.where(inArray(syncRunsTable.binding_id, bindingIds))
			.orderBy(sql`${syncRunsTable.id} DESC`)
			.limit(limit)
			.offset(offset)
			.all()
	}

	activeVersion(bindingId: number): ActiveVersion | undefined {
		return this.db
			.select({
				binding_id: activeVersionsTable.binding_id,
				version_id: activeVersionsTable.version_id,
				activated_at: activeVersionsTable.activated_at,
				source_hash: feedVersionsTable.source_hash,
			})
			.from(activeVersionsTable)
			.innerJoin(feedVersionsTable, eq(feedVersionsTable.id, activeVersionsTable.version_id))
			.where(eq(activeVersionsTable.binding_id, bindingId))
			.get()
	}

	activeVersions(): ActiveVersion[] {
		return this.db
			.select({
				binding_id: activeVersionsTable.binding_id,
				version_id: activeVersionsTable.version_id,
				activated_at: activeVersionsTable.activated_at,
				source_hash: feedVersionsTable.source_hash,
			})
			.from(activeVersionsTable)
			.innerJoin(feedVersionsTable, eq(feedVersionsTable.id, activeVersionsTable.version_id))
			.all()
	}

	/** Writes a complete new version (status building) in one transaction and returns its id. */
	writeVersion(bindingId: number, bundle: StaticBundle, sourceHash: string): number {
		return this.db.transaction((tx) => {
			const versionId = tx
				.insert(feedVersionsTable)
				.values({
					binding_id: bindingId,
					started_at: new Date(),
					status: "building",
					source_hash: sourceHash,
				})
				.returning({ id: feedVersionsTable.id })
				.get().id
			const base = { version_id: versionId, binding_id: bindingId }

			const agencyIds = new Map<string, number>()
			for (const a of bundle.agencies) {
				const id = tx
					.insert(agenciesTable)
					.values({
						...base,
						external_id: a.externalId,
						name: a.name,
						color: a.color ?? null,
						url: a.url ?? null,
						phone: a.phone ?? null,
					})
					.returning({ id: agenciesTable.id })
					.get().id
				agencyIds.set(a.externalId, id)
			}

			const routeIds = new Map<string, number>()
			for (const r of bundle.routes) {
				const id = tx
					.insert(routesTable)
					.values({
						...base,
						external_id: r.externalId,
						short_name: r.shortName,
						long_name: r.longName,
						route_type: r.routeType,
						color: r.color ?? null,
						text_color: r.textColor ?? null,
						agency_id: r.agencyExternalId
							? (agencyIds.get(r.agencyExternalId) ?? null)
							: null,
						is_public: r.isPublic,
						sort: r.sort ?? 0,
					})
					.returning({ id: routesTable.id })
					.get().id
				routeIds.set(r.externalId, id)
			}

			const stopIds = new Map<string, number>()
			for (const s of bundle.stops) {
				const id = tx
					.insert(stopsTable)
					.values({
						...base,
						external_id: s.externalId,
						name: s.name,
						code: s.code ?? null,
						lat_e6: toE6(s.lat),
						lon_e6: toE6(s.lon),
						cell: gridCell(s.lat, s.lon),
						wheelchair: s.wheelchair ?? null,
					})
					.returning({ id: stopsTable.id })
					.get().id
				stopIds.set(s.externalId, id)
			}

			const patternIds = new Map<string, number>()
			for (const p of bundle.patterns) {
				const routeId = routeIds.get(p.routeExternalId)
				if (routeId === undefined) continue
				const stops = p.stops.filter((s) => stopIds.has(s.stopExternalId))
				const id = tx
					.insert(patternsTable)
					.values({
						version_id: versionId,
						route_id: routeId,
						direction: p.direction,
						headsign: p.headsign,
						external_ref: p.externalId,
						shape: encodePolyline(p.shape),
						length_m: Math.round(polylineLengthM(p.shape)),
						stop_count: stops.length,
					})
					.returning({ id: patternsTable.id })
					.get().id
				patternIds.set(p.externalId, id)
				stops.forEach((s, seq) => {
					tx.insert(patternStopsTable)
						.values({
							version_id: versionId,
							pattern_id: id,
							seq: seq + 1,
							stop_id: stopIds.get(s.stopExternalId)!,
							offset_s: s.offsetS,
							dist_m: s.distM ?? null,
						})
						.run()
				})
			}

			const serviceIds = new Map<string, number>()
			for (const s of bundle.services) {
				const id = tx
					.insert(servicesTable)
					.values({
						...base,
						external_id: s.externalId,
						days_mask: s.daysMask,
						label: s.label ?? null,
					})
					.returning({ id: servicesTable.id })
					.get().id
				serviceIds.set(s.externalId, id)
			}

			for (const t of bundle.trips) {
				const patternId = patternIds.get(t.patternExternalId)
				const serviceId = serviceIds.get(t.serviceExternalId)
				if (patternId === undefined || serviceId === undefined) continue
				tx.insert(tripsTable)
					.values({
						version_id: versionId,
						pattern_id: patternId,
						service_id: serviceId,
						external_id: t.externalId,
						start_time_s: t.startTimeS,
						headsign: t.headsign ?? null,
						color: t.color ?? null,
					})
					.run()
			}

			const insertSearch = this.db.$client.prepare(
				"INSERT INTO search_index (kind, ref_id, version_id, binding_id, text) VALUES (?, ?, ?, ?, ?)",
			)
			for (const r of bundle.routes) {
				if (!r.isPublic) continue
				insertSearch.run(
					"route",
					r.externalId,
					versionId,
					bindingId,
					foldTurkish(`${r.shortName} ${r.longName}`),
				)
			}
			for (const s of bundle.stops) {
				insertSearch.run(
					"stop",
					s.externalId,
					versionId,
					bindingId,
					foldTurkish(`${s.name} ${s.code ?? ""}`),
				)
			}
			return versionId
		})
	}

	/**
	 * Atomic swap: the new version becomes active, the previous one is kept as superseded and
	 * anything older is deleted, all in one transaction.
	 */
	activate(bindingId: number, versionId: number, stats: Record<string, number>): void {
		this.db.transaction((tx) => {
			const previous = tx
				.select()
				.from(activeVersionsTable)
				.where(eq(activeVersionsTable.binding_id, bindingId))
				.get()
			tx.insert(activeVersionsTable)
				.values({ binding_id: bindingId, version_id: versionId, activated_at: new Date() })
				.onConflictDoUpdate({
					target: activeVersionsTable.binding_id,
					set: { version_id: versionId, activated_at: new Date() },
				})
				.run()
			tx.update(feedVersionsTable)
				.set({ status: "active", finished_at: new Date(), stats })
				.where(eq(feedVersionsTable.id, versionId))
				.run()
			if (previous) {
				tx.update(feedVersionsTable)
					.set({ status: "superseded" })
					.where(eq(feedVersionsTable.id, previous.version_id))
					.run()
			}
			const keep = [versionId, ...(previous ? [previous.version_id] : [])]
			const stale = tx
				.select({ id: feedVersionsTable.id })
				.from(feedVersionsTable)
				.where(
					and(
						eq(feedVersionsTable.binding_id, bindingId),
						sql`${feedVersionsTable.id} NOT IN (${sql.join(
							keep.map((id) => sql`${id}`),
							sql`, `,
						)})`,
					),
				)
				.all()
				.map((row) => row.id)
			this.deleteVersionRows(tx, stale)
			if (stale.length)
				tx.delete(feedVersionsTable).where(inArray(feedVersionsTable.id, stale)).run()
		})
	}

	/** Removes the rows of a version that failed validation. */
	failVersion(versionId: number, error: string): void {
		this.db.transaction((tx) => {
			this.deleteVersionRows(tx, [versionId])
			tx.update(feedVersionsTable)
				.set({ status: "failed", finished_at: new Date(), error })
				.where(eq(feedVersionsTable.id, versionId))
				.run()
		})
	}

	private deleteVersionRows(tx: Pick<TransitDatabase, "delete">, ids: number[]): void {
		if (!ids.length) return
		for (const table of [
			tripsTable,
			patternStopsTable,
			patternsTable,
			stopsTable,
			routesTable,
			servicesTable,
			agenciesTable,
		]) {
			tx.delete(table).where(inArray(table.version_id, ids)).run()
		}
		const del = this.db.$client.prepare("DELETE FROM search_index WHERE version_id = ?")
		for (const id of ids) del.run(id)
	}

	// ---------- reads ----------

	routes(
		versions: { binding_id: number; version_id: number }[],
		filter: { routeType?: number; q?: string; limit?: number; offset?: number } = {},
	): RouteRow[] {
		if (!versions.length) return []
		const conditions = [
			inArray(
				routesTable.version_id,
				versions.map((v) => v.version_id),
			),
			eq(routesTable.is_public, true),
		]
		if (filter.routeType !== undefined)
			conditions.push(eq(routesTable.route_type, filter.routeType))
		if (filter.q)
			conditions.push(
				sql`(${routesTable.short_name} LIKE ${`${filter.q}%`} OR ${routesTable.long_name} LIKE ${`%${filter.q}%`})`,
			)
		const query = this.db
			.select()
			.from(routesTable)
			.where(and(...conditions))
			.orderBy(asc(routesTable.binding_id), asc(routesTable.sort), asc(routesTable.id))
		if (filter.limit !== undefined)
			return query
				.limit(filter.limit)
				.offset(filter.offset ?? 0)
				.all()
		return query.all()
	}

	countRoutes(versionIds: number[]): number {
		if (!versionIds.length) return 0
		return (
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(routesTable)
				.where(
					and(
						inArray(routesTable.version_id, versionIds),
						eq(routesTable.is_public, true),
					),
				)
				.get()?.n ?? 0
		)
	}

	route(versionId: number, externalId: string): RouteRow | undefined {
		return this.db
			.select()
			.from(routesTable)
			.where(
				and(eq(routesTable.version_id, versionId), eq(routesTable.external_id, externalId)),
			)
			.get()
	}

	routesByIds(ids: number[]): RouteRow[] {
		if (!ids.length) return []
		return this.db.select().from(routesTable).where(inArray(routesTable.id, ids)).all()
	}

	routesByExternal(versionId: number, externalIds: string[]): RouteRow[] {
		if (!externalIds.length) return []
		return this.db
			.select()
			.from(routesTable)
			.where(
				and(
					eq(routesTable.version_id, versionId),
					inArray(routesTable.external_id, externalIds),
				),
			)
			.all()
	}

	agency(id: number): AgencyRow | undefined {
		return this.db.select().from(agenciesTable).where(eq(agenciesTable.id, id)).get()
	}

	routeTypes(versionIds: number[]): number[] {
		if (!versionIds.length) return []
		return this.db
			.selectDistinct({ t: routesTable.route_type })
			.from(routesTable)
			.where(inArray(routesTable.version_id, versionIds))
			.all()
			.map((row) => row.t)
	}

	patternsForRoute(routeId: number, direction?: number): PatternRow[] {
		const conditions = [eq(patternsTable.route_id, routeId)]
		if (direction !== undefined) conditions.push(eq(patternsTable.direction, direction))
		return this.db
			.select()
			.from(patternsTable)
			.where(and(...conditions))
			.orderBy(asc(patternsTable.direction), sql`${patternsTable.stop_count} DESC`)
			.all()
	}

	patternsByIds(ids: number[]): PatternRow[] {
		if (!ids.length) return []
		return this.db.select().from(patternsTable).where(inArray(patternsTable.id, ids)).all()
	}

	patternStops(patternIds: number[]): PatternStopRow[] {
		if (!patternIds.length) return []
		return this.db
			.select({
				pattern_id: patternStopsTable.pattern_id,
				seq: patternStopsTable.seq,
				offset_s: patternStopsTable.offset_s,
				stop_id: stopsTable.id,
				stop_external_id: stopsTable.external_id,
				stop_name: stopsTable.name,
				lat_e6: stopsTable.lat_e6,
				lon_e6: stopsTable.lon_e6,
			})
			.from(patternStopsTable)
			.innerJoin(stopsTable, eq(stopsTable.id, patternStopsTable.stop_id))
			.where(inArray(patternStopsTable.pattern_id, patternIds))
			.orderBy(asc(patternStopsTable.pattern_id), asc(patternStopsTable.seq))
			.all()
	}

	/** Pattern stops visiting `stopId` (one row per visit). */
	visitsOfStop(stopId: number): { pattern_id: number; seq: number; offset_s: number | null }[] {
		return this.db
			.select({
				pattern_id: patternStopsTable.pattern_id,
				seq: patternStopsTable.seq,
				offset_s: patternStopsTable.offset_s,
			})
			.from(patternStopsTable)
			.where(eq(patternStopsTable.stop_id, stopId))
			.all()
	}

	stops(
		versions: { version_id: number }[],
		filter: {
			bbox?: [number, number, number, number]
			q?: string
			limit: number
			offset: number
		},
	): StopRow[] {
		if (!versions.length) return []
		const conditions = [
			inArray(
				stopsTable.version_id,
				versions.map((v) => v.version_id),
			),
		]
		if (filter.bbox) {
			const [w, s, e, n] = filter.bbox
			conditions.push(
				gte(stopsTable.lon_e6, toE6(w)),
				lte(stopsTable.lon_e6, toE6(e)),
				gte(stopsTable.lat_e6, toE6(s)),
				lte(stopsTable.lat_e6, toE6(n)),
			)
		}
		if (filter.q)
			conditions.push(
				sql`(${stopsTable.name} LIKE ${`%${filter.q}%`} OR ${stopsTable.code} = ${filter.q})`,
			)
		return this.db
			.select()
			.from(stopsTable)
			.where(and(...conditions))
			.orderBy(asc(stopsTable.id))
			.limit(filter.limit)
			.offset(filter.offset)
			.all()
	}

	countStops(versionIds: number[]): number {
		if (!versionIds.length) return 0
		return (
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(stopsTable)
				.where(inArray(stopsTable.version_id, versionIds))
				.get()?.n ?? 0
		)
	}

	stop(versionId: number, externalId: string): StopRow | undefined {
		return this.db
			.select()
			.from(stopsTable)
			.where(
				and(eq(stopsTable.version_id, versionId), eq(stopsTable.external_id, externalId)),
			)
			.get()
	}

	stopsByIds(ids: number[]): StopRow[] {
		if (!ids.length) return []
		return this.db.select().from(stopsTable).where(inArray(stopsTable.id, ids)).all()
	}

	stopsInCells(versionIds: number[], cells: number[]): StopRow[] {
		if (!versionIds.length || !cells.length) return []
		return this.db
			.select()
			.from(stopsTable)
			.where(and(inArray(stopsTable.version_id, versionIds), inArray(stopsTable.cell, cells)))
			.all()
	}

	/** Routes serving each stop (distinct per stop). */
	routesServingStops(stopIds: number[]): { stop_id: number; route_id: number }[] {
		if (!stopIds.length) return []
		return this.db
			.selectDistinct({
				stop_id: patternStopsTable.stop_id,
				route_id: patternsTable.route_id,
			})
			.from(patternStopsTable)
			.innerJoin(patternsTable, eq(patternsTable.id, patternStopsTable.pattern_id))
			.where(inArray(patternStopsTable.stop_id, stopIds))
			.all()
	}

	services(versionId: number): ServiceRow[] {
		return this.db
			.select()
			.from(servicesTable)
			.where(eq(servicesTable.version_id, versionId))
			.all()
	}

	tripsForPatterns(
		patternIds: number[],
		serviceIds: number[],
		window?: { from: number; to: number },
	): TripRow[] {
		if (!patternIds.length || !serviceIds.length) return []
		const conditions = [
			inArray(tripsTable.pattern_id, patternIds),
			inArray(tripsTable.service_id, serviceIds),
		]
		if (window)
			conditions.push(
				gte(tripsTable.start_time_s, window.from),
				lt(tripsTable.start_time_s, window.to),
			)
		return this.db
			.select()
			.from(tripsTable)
			.where(and(...conditions))
			.orderBy(asc(tripsTable.start_time_s))
			.all()
	}

	tripByExternal(versionId: number, externalId: string): TripRow | undefined {
		return this.db
			.select()
			.from(tripsTable)
			.where(
				and(eq(tripsTable.version_id, versionId), eq(tripsTable.external_id, externalId)),
			)
			.get()
	}

	/** Pattern of a route external id and direction in a version (largest first). */
	patternByRoute(versionId: number, routeExt: string, direction: number): PatternRow | undefined {
		const route = this.route(versionId, routeExt)
		if (!route) return undefined
		return this.patternsForRoute(route.id, direction)[0]
	}

	countTrips(versionId: number): number {
		return (
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(tripsTable)
				.where(eq(tripsTable.version_id, versionId))
				.get()?.n ?? 0
		)
	}

	/** FTS5 search over folded text; `match` comes from ftsQuery(). */
	search(versionIds: number[], match: string, limit: number): SearchHit[] {
		if (!versionIds.length) return []
		const placeholders = versionIds.map(() => "?").join(", ")
		return this.db.$client
			.query<SearchHit, (string | number)[]>(
				`SELECT kind, ref_id, binding_id, bm25(search_index) AS rank FROM search_index
				 WHERE search_index MATCH ? AND version_id IN (${placeholders})
				 ORDER BY kind = 'route' DESC, rank LIMIT ?`,
			)
			.all(match, ...versionIds, limit)
	}

	/** Versions other than the active ones (for tests and cleanup checks). */
	versionCount(bindingId: number): number {
		return (
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(feedVersionsTable)
				.where(
					and(
						eq(feedVersionsTable.binding_id, bindingId),
						ne(feedVersionsTable.status, "failed"),
					),
				)
				.get()?.n ?? 0
		)
	}
}
