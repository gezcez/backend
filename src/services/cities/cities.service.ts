// cities.service.ts
// City list and the city manifest (plan 6.5): networks with status, merged capabilities,
// pack_version, attribution, privacy and data freshness. Successor of FKart's dynamic/ folder.

import { Injectable } from "@nestjs/common"
import { MODE_LABELS, type Mode } from "@common/models/transit.models"
import { fromE6, sha256Base64Url } from "@common/utils"
import type { CityRow, NetworkRow } from "@schemas/core"
import { NetworksService, mergeCapabilities } from "@services/networks/networks.service"
import { TransitService } from "@services/transit/transit.service"

/** Static data older than this is flagged in the manifest. */
const STATIC_OUTDATED_MS = 3 * 86400 * 1000

@Injectable()
export class CitiesService {
	constructor(
		private readonly networks: NetworksService,
		private readonly transit: TransitService,
	) {}

	private cityBase(city: CityRow) {
		return {
			id: city.id,
			slug: city.slug,
			name: city.name,
			country_code: city.country_code,
			timezone: city.timezone,
			centre:
				city.center_lat_e6 !== null && city.center_lon_e6 !== null
					? ([fromE6(city.center_lon_e6), fromE6(city.center_lat_e6)] as [number, number])
					: null,
			bbox: city.bbox ?? null,
		}
	}

	networkManifest(network: NetworkRow) {
		const bindings = this.networks.effectiveBindings(network.id)
		const status = this.networks.networkStatus(bindings)
		const versions = this.transit.networkVersions(network.id)
		const versionIds = versions.map((v) => v.version_id)
		const capabilities = mergeCapabilities(bindings.map((b) => b.capabilities))
		if (!versions.length) {
			capabilities.stops = false
			capabilities.routes = false
			capabilities.timetables = false
			capabilities.shapes = false
		}
		const syncedAt = versions.length
			? Math.min(...versions.map((v) => v.activated_at.getTime()))
			: null
		const feedTs = bindings
			.map((b) => b.lastFeedTs)
			.filter((ts): ts is number => typeof ts === "number")
		const providers = [...new Map(bindings.map((b) => [b.provider.key, b.provider])).values()]
		const killed = bindings.length > 0 && bindings.every((b) => b.state === "killed")
		return {
			id: network.id,
			slug: network.slug,
			name: network.name,
			operator_name: network.operator_name,
			colour: network.color,
			status: status.status,
			status_message: status.message,
			modes: this.transit.modes(versionIds),
			city_id: network.city_id,
			capabilities,
			pack_version: versions.length
				? versions
						.map((v) => `${v.binding_id}-${v.version_id}`)
						.sort()
						.join(".")
				: null,
			attribution: providers.map((p) => ({ provider: p.key, name: p.name, url: p.url })),
			privacy: providers.map((p) => ({ provider: p.key, pulled_data: p.pulled_data })),
			freshness: {
				static_synced_at: syncedAt ? new Date(syncedAt).toISOString() : null,
				realtime_feed_at: feedTs.length
					? new Date(Math.max(...feedTs) * 1000).toISOString()
					: null,
				static_may_be_outdated:
					killed || (syncedAt !== null && Date.now() - syncedAt > STATIC_OUTDATED_MS),
			},
		}
	}

	private summary(network: NetworkRow) {
		const m = this.networkManifest(network)
		return {
			id: m.id,
			slug: m.slug,
			name: m.name,
			operator_name: m.operator_name,
			colour: m.colour,
			status: m.status,
			status_message: m.status_message,
			modes: m.modes,
		}
	}

	listCities() {
		return this.networks.listCities(true).map((city) => ({
			...this.cityBase(city),
			networks: this.networks
				.listNetworks({ cityId: city.id, publicOnly: true })
				.map((n) => this.summary(n)),
		}))
	}

	manifest(slug: string) {
		const city = this.networks.city(slug)
		const networks = this.networks
			.listNetworks({ cityId: city.id, publicOnly: true })
			.map((n) => this.networkManifest(n))
		const modes = [...new Set(networks.flatMap((n) => n.modes))].sort() as Mode[]
		const base = this.cityBase(city)
		return {
			city: base,
			networks,
			route_types: modes.map((mode) => ({ mode, label: MODE_LABELS[mode] })),
			map: { centre: base.centre, bbox: base.bbox, initial_zoom: 11 },
			generated_at: new Date().toISOString(),
		}
	}

	network(ref: string) {
		return this.networkManifest(this.networks.network(ref))
	}

	providers() {
		return this.networks.listProviders().map((p) => ({
			key: p.key,
			name: p.name,
			url: p.url,
			image_url: p.image_url,
			enabled: p.enabled,
			pulled_data: p.pulled_data,
			legal_note: p.legal_note,
		}))
	}

	/** Strong ETag over the content (generated_at excluded). */
	static etag(value: unknown): string {
		const { generated_at: _ignored, ...rest } = value as Record<string, unknown>
		return `"${sha256Base64Url(JSON.stringify(rest)).slice(0, 27)}"`
	}
}
