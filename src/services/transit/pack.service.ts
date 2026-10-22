// pack.service.ts
// The per-network offline pack (plan 6.5): stops (stable id, name, code, lat, lon, modes, route
// ids) and routes (names, mode, colours, directions with headsign and ordered stop ids). The app
// indexes it for offline nearby and search, so most riders never send coordinates. Built after
// each successful sync and on demand, versioned by `pack_version`, gzipped once, strong ETag.

import { gzipSync } from "node:zlib"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { GezcezError } from "@common/errors"
import { modeOf, type Mode } from "@common/models/transit.models"
import { fromE6, publicRef } from "@common/utils"
import type { NetworkRow } from "@schemas/core"
import { NetworksService } from "@services/networks/networks.service"
import { TransitRepository } from "./transit.repository"
import { TransitService } from "./transit.service"
import { TransitSyncService } from "./transit-sync.service"

export interface PackStop {
	id: string
	name: string
	code: string | null
	lat: number
	lon: number
	modes: Mode[]
	route_ids: string[]
}

export interface PackRoute {
	id: string
	short_name: string
	long_name: string
	mode: Mode
	colour: string | null
	text_colour: string | null
	directions: { direction: 0 | 1; headsign: string; stop_ids: string[] }[]
}

export interface Pack {
	network: string
	network_id: number
	pack_version: string
	built_at: string
	stops: PackStop[]
	routes: PackRoute[]
}

export interface BuiltPack {
	version: string
	etag: string
	/** The full `{ok, data}` envelope, serialised once. */
	json: string
	gzip: Uint8Array
	builtAt: string
	stops: number
	routes: number
}

/** `pack_version` of a network: its bindings' active versions (same value as the manifest). */
export function packVersionOf(versions: { binding_id: number; version_id: number }[]) {
	return versions.length
		? versions
				.map((v) => `${v.binding_id}-${v.version_id}`)
				.sort()
				.join(".")
		: null
}

const round5 = (value: number) => Math.round(value * 1e5) / 1e5

@Injectable()
export class PackService implements OnApplicationBootstrap {
	private readonly logger = new Logger("Pack")
	private readonly cache = new Map<number, BuiltPack>()

	constructor(
		private readonly networks: NetworksService,
		private readonly transit: TransitService,
		private readonly repository: TransitRepository,
		private readonly sync: TransitSyncService,
	) {}

	onApplicationBootstrap(): void {
		// Rebuild the packs of a binding's network right after a sync that changed data.
		this.sync.onSynced((result) => {
			if (result.status !== "ok") return
			const binding = this.networks.bindings().find((b) => b.id === result.binding_id)
			if (!binding) return
			this.cache.delete(binding.network_id)
			try {
				const network = this.networks.network(String(binding.network_id), false)
				this.build(network)
			} catch (error) {
				this.logger.warn(`pack build failed: ${(error as Error).message}`)
			}
		})
	}

	/** The current pack of a public network, built on first use of a version. */
	pack(networkRef: string): BuiltPack {
		const network = this.networks.network(networkRef)
		const version = packVersionOf(this.transit.networkVersions(network.id))
		if (!version) throw new GezcezError("NOT_FOUND", "This network has no static data yet")
		const cached = this.cache.get(network.id)
		if (cached?.version === version) return cached
		return this.build(network)
	}

	private build(network: NetworkRow): BuiltPack {
		const started = Date.now()
		const versions = this.transit.networkVersions(network.id)
		const version = packVersionOf(versions)
		if (!version) throw new GezcezError("NOT_FOUND", "This network has no static data yet")
		const versionIds = versions.map((v) => v.version_id)
		const routes = this.repository.routes(versions)
		const patterns = this.repository.patternsOfRoutes(routes.map((r) => r.id))
		// The largest pattern per route and direction carries the direction's stop order.
		const chosen = new Map<string, (typeof patterns)[number]>()
		for (const p of patterns) {
			const key = `${p.route_id}|${p.direction}`
			if (!chosen.has(key)) chosen.set(key, p)
		}
		const stopsByPattern = new Map<number, { ext: string; name: string }[]>()
		for (const row of this.repository.patternStops([...chosen.values()].map((p) => p.id))) {
			const list = stopsByPattern.get(row.pattern_id) ?? []
			list.push({ ext: row.stop_external_id, name: row.stop_name })
			stopsByPattern.set(row.pattern_id, list)
		}
		// Every pattern (not only the chosen ones) counts for "routes serving this stop".
		const routeOfPattern = new Map(patterns.map((p) => [p.id, p.route_id]))
		const servingRoutes = new Map<number, Set<number>>()
		for (const row of this.repository.patternStops(patterns.map((p) => p.id))) {
			const routeId = routeOfPattern.get(row.pattern_id)
			if (routeId === undefined) continue
			const set = servingRoutes.get(row.stop_id) ?? new Set()
			set.add(routeId)
			servingRoutes.set(row.stop_id, set)
		}
		const routeById = new Map(routes.map((r) => [r.id, r]))

		const packRoutes: PackRoute[] = routes.map((r) => ({
			id: publicRef(r.binding_id, r.external_id),
			short_name: r.short_name,
			long_name: r.long_name,
			mode: modeOf(r.route_type),
			colour: r.color,
			text_colour: r.text_color,
			directions: ([0, 1] as const).flatMap((direction) => {
				const pattern = chosen.get(`${r.id}|${direction}`)
				const stops = pattern ? (stopsByPattern.get(pattern.id) ?? []) : []
				if (!pattern || !stops.length) return []
				return [
					{
						direction,
						headsign: pattern.headsign ?? stops[stops.length - 1]!.name,
						stop_ids: stops.map((s) => publicRef(r.binding_id, s.ext)),
					},
				]
			}),
		}))
		const packStops: PackStop[] = this.repository.allStops(versionIds).map((s) => {
			const served = [...(servingRoutes.get(s.id) ?? [])]
				.map((id) => routeById.get(id))
				.filter((r) => r !== undefined)
			return {
				id: publicRef(s.binding_id, s.external_id),
				name: s.name,
				code: s.code,
				lat: round5(fromE6(s.lat_e6)),
				lon: round5(fromE6(s.lon_e6)),
				modes: [...new Set(served.map((r) => modeOf(r.route_type)))].sort(),
				route_ids: served.map((r) => publicRef(r.binding_id, r.external_id)),
			}
		})
		const builtAt = new Date().toISOString()
		const pack: Pack = {
			network: network.slug,
			network_id: network.id,
			pack_version: version,
			built_at: builtAt,
			stops: packStops,
			routes: packRoutes,
		}
		const json = JSON.stringify({ ok: true, data: pack })
		const built: BuiltPack = {
			version,
			etag: `"pack-${version}"`,
			json,
			gzip: gzipSync(json, { level: 9 }),
			builtAt,
			stops: packStops.length,
			routes: packRoutes.length,
		}
		this.cache.set(network.id, built)
		this.logger.log(
			`pack ${network.slug} ${version}: ${built.stops} stops, ${built.routes} routes, ${built.gzip.byteLength} bytes gzipped in ${Date.now() - started} ms`,
		)
		return built
	}
}
