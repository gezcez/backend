// alerts.service.ts
// Service alerts per network (plan 6.11, capability `alerts`). Only bindings whose provider
// declares alerts (and are not killed) are asked; answers are cached 5 min per binding with one
// upstream request in flight, and a failing provider serves its last answer or nothing.

import { Injectable, Logger } from "@nestjs/common"
import { publicRef } from "@common/utils"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import type { ServiceAlert } from "@services/providers/transit-provider.interface"

export const ALERTS_TTL_MS = 5 * 60_000
const ALERTS_TIMEOUT_MS = 10_000

export interface AlertView {
	id: string
	network_id: number
	title: string
	body: string
	severity: "info" | "warning" | "severe"
	route_ids: string[]
	active_from: string
	active_to: string | null
	url: string | null
}

interface Entry {
	at: number
	alerts: ServiceAlert[]
	inflight?: Promise<ServiceAlert[]>
}

@Injectable()
export class AlertsService {
	private readonly logger = new Logger("Alerts")
	private readonly cache = new Map<number, Entry>()
	now: () => number = Date.now

	constructor(
		private readonly networks: NetworksService,
		private readonly providers: ProvidersRegistry,
	) {}

	private async forBinding(bindingId: number, providerKey: string): Promise<ServiceAlert[]> {
		const entry = this.cache.get(bindingId)
		if (entry && this.now() - entry.at < ALERTS_TTL_MS) return entry.alerts
		if (entry?.inflight) return entry.inflight
		const adapter = this.providers.get(providerKey)
		if (!adapter?.fetchAlerts) return []
		const fetchAlerts = adapter.fetchAlerts.bind(adapter)
		const context = this.networks.bindingContext(bindingId)
		const inflight = fetchAlerts(context, AbortSignal.timeout(ALERTS_TIMEOUT_MS))
			.then((alerts) => {
				this.cache.set(bindingId, { at: this.now(), alerts })
				return alerts
			})
			.catch((error: unknown) => {
				this.logger.warn(
					`alerts of binding ${bindingId} failed: ${(error as Error).message}`,
				)
				const stale = entry?.alerts ?? []
				// Retry after a minute, not on every request.
				this.cache.set(bindingId, {
					at: this.now() - ALERTS_TTL_MS + 60_000,
					alerts: stale,
				})
				return stale
			})
		this.cache.set(bindingId, { at: entry?.at ?? 0, alerts: entry?.alerts ?? [], inflight })
		return inflight
	}

	async list(networkRef: string): Promise<AlertView[]> {
		const network = this.networks.network(networkRef)
		const nowS = Math.floor(this.now() / 1000)
		const out: AlertView[] = []
		for (const effective of this.networks.effectiveBindings(network.id)) {
			if (!effective.enabled || !effective.capabilities.alerts) continue
			const bindingId = effective.binding.id
			const alerts = await this.forBinding(bindingId, effective.binding.provider_key)
			for (const a of alerts) {
				if (a.activeTo !== null && a.activeTo <= nowS) continue
				out.push({
					id: publicRef(bindingId, a.externalId),
					network_id: network.id,
					title: a.title,
					body: a.body,
					severity: a.severity,
					route_ids: a.routeExts.map((r) => publicRef(bindingId, r)),
					active_from: new Date(a.activeFrom * 1000).toISOString(),
					active_to:
						a.activeTo === null ? null : new Date(a.activeTo * 1000).toISOString(),
					url: a.url,
				})
			}
		}
		const rank = { severe: 0, warning: 1, info: 2 }
		return out.sort(
			(a, b) =>
				rank[a.severity] - rank[b.severity] || b.active_from.localeCompare(a.active_from),
		)
	}
}
