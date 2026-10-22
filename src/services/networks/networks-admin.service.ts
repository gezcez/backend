// networks-admin.service.ts
// Builds the dashboard catalog views: cities, networks with bindings and runtime state,
// providers with their config schema and credential health (never secrets).

import { Injectable } from "@nestjs/common"
import { z } from "zod"
import { GezcezError } from "@common/errors"
import type { CityRow, NetworkRow, ProviderBindingRow, ProviderRow } from "@schemas/core"
import { KentkartBindingConfigSchema } from "@services/providers/kentkart/kentkart.filters"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import type { CredentialStatus } from "@services/providers/transit-provider.interface"
import { BindingHealthRegistry } from "./binding-health.registry"
import { NetworksService } from "./networks.service"

const CONFIG_SCHEMAS: Record<string, z.ZodType> = { kentkart: KentkartBindingConfigSchema }

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null)

@Injectable()
export class NetworksAdminService {
	constructor(
		private readonly catalog: NetworksService,
		private readonly registry: ProvidersRegistry,
		private readonly health: BindingHealthRegistry,
	) {}

	city(row: CityRow) {
		return {
			id: row.id,
			slug: row.slug,
			name: row.name,
			country_code: row.country_code,
			timezone: row.timezone,
			center_lat: row.center_lat_e6 === null ? null : row.center_lat_e6 / 1e6,
			center_lon: row.center_lon_e6 === null ? null : row.center_lon_e6 / 1e6,
			bbox: row.bbox ?? null,
			status: row.status,
			sort: row.sort,
		}
	}

	cities() {
		return this.catalog.listCities(false).map((c) => this.city(c))
	}

	private bindingView(binding: ProviderBindingRow, provider: ProviderRow) {
		const effective = this.catalog.effectiveBinding(binding, provider)
		return {
			id: binding.id,
			network_id: binding.network_id,
			provider_key: binding.provider_key,
			external_ref: binding.external_ref,
			config: binding.config,
			capabilities: effective.capabilities,
			poll_interval_s: binding.poll_interval_s,
			idle_poll_interval_s: binding.idle_poll_interval_s,
			status: binding.status,
			disabled_reason: binding.disabled_reason,
			state: effective.state,
			state_message: effective.message,
			last_feed_at: effective.lastFeedTs
				? new Date(effective.lastFeedTs * 1000).toISOString()
				: null,
			replayed: this.registry.isReplayed(binding.provider_key),
			created_at: binding.created_at.toISOString(),
			updated_at: iso(binding.updated_at),
		}
	}

	private networkView(network: NetworkRow) {
		const providers = new Map(this.catalog.listProviders().map((p) => [p.key, p]))
		const bindings = this.catalog.bindings(network.id).flatMap((b) => {
			const provider = providers.get(b.provider_key)
			return provider ? [this.bindingView(b, provider)] : []
		})
		const status = this.catalog.networkStatus(this.catalog.effectiveBindings(network.id))
		return {
			id: network.id,
			city_id: network.city_id,
			slug: network.slug,
			name: network.name,
			operator_name: network.operator_name,
			colour: network.color,
			status: network.status,
			network_status: status.status,
			network_status_message: status.message,
			bindings,
			created_at: network.created_at.toISOString(),
			updated_at: iso(network.updated_at),
		}
	}

	listNetworks(filter?: (networkId: number) => boolean) {
		return this.catalog
			.listNetworks({ publicOnly: false })
			.filter((n) => !filter || filter(n.id))
			.map((n) => this.networkView(n))
	}

	network(networkId: number) {
		return this.networkView(this.catalog.network(String(networkId), false))
	}

	binding(networkId: number, bindingId: number) {
		const view = this.network(networkId).bindings.find((b) => b.id === bindingId)
		if (!view) throw new GezcezError("NOT_FOUND", "Binding not found")
		return view
	}

	private providerView(row: ProviderRow) {
		const adapter = this.registry.adapter(row.key)
		return {
			key: row.key,
			name: row.name,
			url: row.url,
			image_url: row.image_url,
			enabled: row.enabled,
			env_enabled: this.registry.envEnabled(row.key),
			disabled_reason: row.disabled_reason,
			adapter: Boolean(adapter),
			replayed: this.registry.isReplayed(row.key),
			capabilities: adapter?.describe().capabilities ?? null,
			pulled_data: row.pulled_data,
			legal_note: row.legal_note,
			binding_count: this.catalog.bindings().filter((b) => b.provider_key === row.key).length,
		}
	}

	listProviders() {
		return this.catalog.listProviders().map((p) => this.providerView(p))
	}

	provider(key: string) {
		const row = this.catalog.provider(key)
		const adapter = this.registry.adapter(key)
		const schema = CONFIG_SCHEMAS[key]
		const hint = adapter?.describe().rateHint
		const credentials = new Map<string, CredentialStatus>()
		for (const ctx of this.catalog.bindingsWithContext()) {
			if (ctx.binding.provider_key !== key) continue
			// Prefer what the tracker reports; it holds the live token.
			const status =
				this.health.get(ctx.binding.id)?.credentials ??
				adapter?.credentialStatus?.(NetworksService.context(ctx)) ??
				null
			if (status) credentials.set(status.realm, status)
		}
		return {
			...this.providerView(row),
			config_schema: schema
				? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>)
				: null,
			rate_hint: hint
				? { host: hint.host, requests_per_second: hint.requestsPerSecond }
				: null,
			credentials: [...credentials.values()].map((c) => ({
				realm: c.realm,
				state: c.state,
				expires_at: c.expiresAt ? new Date(c.expiresAt * 1000).toISOString() : null,
				refreshed_at: c.refreshedAt ? new Date(c.refreshedAt * 1000).toISOString() : null,
				failures: c.failures,
				secrets_set: c.secretsSet,
			})),
		}
	}

	setProviderEnabled(key: string, enabled: boolean, reason: string, userId: number) {
		this.catalog.setProviderEnabled(key, enabled, reason, userId)
		return this.providerView(this.catalog.provider(key))
	}
}
