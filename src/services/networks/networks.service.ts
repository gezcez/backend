// networks.service.ts
// Catalog resolution (slug or id), binding contexts for adapters, the kill switch levels and
// capability merging per network (plan 6.5 and 8.9).

import { Injectable } from "@nestjs/common"
import { GezcezError } from "@common/errors"
import type {
	CatalogStatus,
	CityRow,
	NetworkRow,
	ProviderBindingRow,
	ProviderRow,
} from "@schemas/core"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import {
	NO_CAPABILITIES,
	type BindingContext,
	type Capabilities,
	type RealtimeDeparturesLevel,
} from "@services/providers/transit-provider.interface"
import { BindingHealthRegistry, type BindingRuntimeState } from "./binding-health.registry"
import { NetworksRepository, type BindingWithContext } from "./networks.repository"

export type NetworkStatus = "active" | "degraded" | "disabled"

export interface EffectiveBinding {
	binding: ProviderBindingRow
	provider: ProviderRow
	/** Whether pollers and syncs may call upstream at all. */
	enabled: boolean
	state: BindingRuntimeState
	message: string | null
	lastFeedTs: number | null
	capabilities: Capabilities
}

const DEPARTURE_RANK: Record<RealtimeDeparturesLevel, number> = { none: 0, estimated: 1, live: 2 }

/** Capability booleans OR-ed, departures the best level, card the first non-null. */
export function mergeCapabilities(list: Capabilities[]): Capabilities {
	const merged: Capabilities = { ...NO_CAPABILITIES }
	for (const c of list) {
		merged.stops ||= c.stops
		merged.routes ||= c.routes
		merged.timetables ||= c.timetables
		merged.shapes ||= c.shapes
		merged.realtime_vehicles ||= c.realtime_vehicles
		merged.trip_updates ||= c.trip_updates
		merged.alerts ||= c.alerts
		if (DEPARTURE_RANK[c.realtime_departures] > DEPARTURE_RANK[merged.realtime_departures])
			merged.realtime_departures = c.realtime_departures
		merged.card ??= c.card
	}
	return merged
}

const PUBLIC: CatalogStatus[] = ["public"]

@Injectable()
export class NetworksService {
	constructor(
		private readonly repository: NetworksRepository,
		private readonly providers: ProvidersRegistry,
		private readonly health: BindingHealthRegistry,
	) {}

	private readonly changeListeners: (() => void)[] = []

	/** Called after catalog writes that affect pollers (kill switch, binding edits). */
	onCatalogChanged(listener: () => void): void {
		this.changeListeners.push(listener)
	}

	setProviderEnabled(key: string, enabled: boolean, reason: string, userId: number | null): void {
		this.provider(key)
		this.repository.setProviderEnabled(key, enabled, reason, userId)
		for (const listener of this.changeListeners) listener()
	}

	listCities(publicOnly = true): CityRow[] {
		return this.repository.listCities(publicOnly ? PUBLIC : undefined)
	}

	city(ref: string, publicOnly = true): CityRow {
		const city = this.repository.findCity(ref)
		if (!city || (publicOnly && city.status !== "public"))
			throw new GezcezError("NOT_FOUND", "City not found")
		return city
	}

	cityById(id: number): CityRow | undefined {
		return this.repository.cityById(id)
	}

	listNetworks(filter: { cityId?: number; publicOnly?: boolean } = {}): NetworkRow[] {
		return this.repository.listNetworks({
			cityId: filter.cityId,
			statuses: filter.publicOnly === false ? undefined : PUBLIC,
		})
	}

	/** Resolves `:networkId` (slug or numeric id). Hidden and draft networks are not public. */
	network(ref: string, publicOnly = true): NetworkRow {
		const network = this.repository.findNetwork(ref)
		if (!network || (publicOnly && network.status !== "public"))
			throw new GezcezError("NOT_FOUND", "Network not found")
		return network
	}

	listProviders(): ProviderRow[] {
		return this.repository.listProviders()
	}

	provider(key: string): ProviderRow {
		const provider = this.repository.findProvider(key)
		if (!provider) throw new GezcezError("NOT_FOUND", "Provider not found")
		return provider
	}

	bindings(networkId?: number): ProviderBindingRow[] {
		return this.repository.listBindings(networkId)
	}

	binding(id: number): ProviderBindingRow {
		const binding = this.repository.findBinding(id)
		if (!binding) throw new GezcezError("NOT_FOUND", "Binding not found")
		return binding
	}

	bindingsWithContext(): BindingWithContext[] {
		return this.repository.bindingsWithContext()
	}

	static context(row: BindingWithContext): BindingContext {
		return {
			id: row.binding.id,
			networkId: row.network.id,
			providerKey: row.binding.provider_key,
			externalRef: row.binding.external_ref,
			config: {
				...row.binding.config,
				centre:
					row.city.center_lat_e6 !== null && row.city.center_lon_e6 !== null
						? [row.city.center_lon_e6 / 1e6, row.city.center_lat_e6 / 1e6]
						: undefined,
			},
			bbox: row.city.bbox ?? null,
			timezone: row.city.timezone,
		}
	}

	bindingContext(bindingId: number): BindingContext {
		const row = this.repository.bindingsWithContext().find((r) => r.binding.id === bindingId)
		if (!row) throw new GezcezError("NOT_FOUND", "Binding not found")
		return NetworksService.context(row)
	}

	/** Kill switch levels: env hard kill, providers.enabled, then binding status. */
	killReason(binding: ProviderBindingRow, provider: ProviderRow): string | null {
		if (!this.providers.envEnabled(provider.key))
			return `Provider ${provider.key} is disabled by the operator`
		if (!provider.enabled)
			return provider.disabled_reason ?? `Provider ${provider.key} is disabled`
		if (binding.status === "disabled") return binding.disabled_reason ?? "Binding is disabled"
		return null
	}

	effectiveBinding(binding: ProviderBindingRow, provider: ProviderRow): EffectiveBinding {
		const kill = this.killReason(binding, provider)
		const adapter = this.providers.get(provider.key)
		const declared = adapter?.describe().capabilities ?? NO_CAPABILITIES
		const capabilities: Capabilities = {
			...declared,
			...adapter?.bindingCapabilities?.(binding.config),
			...(binding.capabilities as Partial<Capabilities>),
		}
		const runtime = this.health.get(binding.id)
		let state: BindingRuntimeState
		let message: string | null = null
		if (kill) {
			state = "killed"
			message = kill
		} else if (binding.status === "paused") {
			state = "paused"
			message = binding.disabled_reason ?? "Live data is paused"
		} else {
			state = runtime?.state ?? "unknown"
			message = runtime?.message ?? null
		}
		if (state === "killed" || !adapter) {
			capabilities.realtime_vehicles = false
			capabilities.realtime_departures = "none"
			capabilities.trip_updates = false
			capabilities.card = null
		}
		return {
			binding,
			provider,
			enabled: !kill && Boolean(adapter),
			state,
			message,
			lastFeedTs: runtime?.lastFeedTs ?? null,
			capabilities,
		}
	}

	effectiveBindings(networkId: number): EffectiveBinding[] {
		return this.repository.listBindings(networkId).flatMap((binding) => {
			const provider = this.repository.findProvider(binding.provider_key)
			return provider ? [this.effectiveBinding(binding, provider)] : []
		})
	}

	/** Network status from its bindings (plan 6.5). */
	networkStatus(bindings: EffectiveBinding[]): { status: NetworkStatus; message: string | null } {
		if (!bindings.length) return { status: "disabled", message: "No data source" }
		if (bindings.every((b) => b.state === "killed"))
			return { status: "disabled", message: bindings[0]?.message ?? "Data source disabled" }
		const troubled = bindings.find((b) => !["ok", "unknown"].includes(b.state))
		if (troubled) {
			return {
				status: "degraded",
				message:
					troubled.state === "paused" ||
					troubled.state === "down" ||
					troubled.state === "killed"
						? "Live data paused"
						: "Live data delayed",
			}
		}
		return { status: "active", message: null }
	}
}
