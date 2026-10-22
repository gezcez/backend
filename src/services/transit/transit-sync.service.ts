// transit-sync.service.ts
// Daily per-binding import of static data from the provider into transit.db with a versioned,
// atomic swap (plan 5.2). Runs in the API process only (single writer of transit.db).

import {
	Injectable,
	Logger,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { localTime, sha256Hex } from "@common/utils"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import type { StaticChunk } from "@services/providers/transit-provider.interface"
import { TransitRepository, type StaticBundle } from "./transit.repository"

export interface SyncResult {
	binding_id: number
	run_id: number
	status: "ok" | "unchanged" | "failed"
	version_id: number | null
	counts: Record<string, number>
	warnings: string[]
	error: string | null
}

const MAX_WARNINGS = 200

/** Reserved seam (plan 6.17): a later normalisation module can rewrite chunks here. */
export type ChunkNormaliser = (chunk: StaticChunk) => StaticChunk

/** Drops dangling references and reports them; throws when the bundle is unusable. */
export function validateBundle(bundle: StaticBundle): { bundle: StaticBundle; warnings: string[] } {
	const warnings: string[] = []
	const dedupe = <T extends { externalId: string }>(items: T[], kind: string): T[] => {
		const seen = new Map<string, T>()
		for (const item of items) {
			if (seen.has(item.externalId)) warnings.push(`duplicate ${kind} ${item.externalId}`)
			else seen.set(item.externalId, item)
		}
		return [...seen.values()]
	}
	const routes = dedupe(bundle.routes, "route")
	const stops = dedupe(
		bundle.stops.filter((s) => {
			const ok =
				Number.isFinite(s.lat) &&
				Number.isFinite(s.lon) &&
				Math.abs(s.lat) <= 90 &&
				Math.abs(s.lon) <= 180 &&
				!(s.lat === 0 && s.lon === 0)
			if (!ok) warnings.push(`stop ${s.externalId} has no usable coordinates`)
			return ok
		}),
		"stop",
	)
	const routeIds = new Set(routes.map((r) => r.externalId))
	const stopIds = new Set(stops.map((s) => s.externalId))
	const patterns = dedupe(bundle.patterns, "pattern").filter((p) => {
		if (!routeIds.has(p.routeExternalId)) {
			warnings.push(`pattern ${p.externalId} references unknown route ${p.routeExternalId}`)
			return false
		}
		const missing = p.stops.filter((s) => !stopIds.has(s.stopExternalId))
		if (missing.length)
			warnings.push(`pattern ${p.externalId} drops ${missing.length} unknown stops`)
		return p.stops.length - missing.length >= 2
	})
	const patternIds = new Set(patterns.map((p) => p.externalId))
	const services = dedupe(bundle.services, "service")
	const serviceIds = new Set(services.map((s) => s.externalId))
	const seenTrips = new Set<string>()
	let danglingTrips = 0
	const trips = bundle.trips.filter((t) => {
		const key = `${t.patternExternalId}|${t.serviceExternalId}|${t.externalId}|${t.startTimeS}`
		if (seenTrips.has(key)) return false
		seenTrips.add(key)
		const ok = patternIds.has(t.patternExternalId) && serviceIds.has(t.serviceExternalId)
		if (!ok) danglingTrips++
		return ok
	})
	if (danglingTrips)
		warnings.push(`${danglingTrips} trips reference unknown patterns or services`)
	if (!routes.length) throw new Error("no routes in the upstream data")
	if (!stops.length) throw new Error("no stops in the upstream data")
	const servedRoutes = new Set(patterns.map((p) => p.routeExternalId))
	const unserved = routes.filter((r) => !servedRoutes.has(r.externalId)).length
	if (unserved) warnings.push(`${unserved} routes have no pattern`)
	return {
		bundle: {
			agencies: dedupe(bundle.agencies, "agency"),
			routes,
			stops,
			patterns,
			services,
			trips,
		},
		warnings,
	}
}

@Injectable()
export class TransitSyncService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = new Logger("TransitSync")
	private readonly running = new Map<number, Promise<SyncResult>>()
	private timer: ReturnType<typeof setTimeout> | undefined
	private bootTimer: ReturnType<typeof setTimeout> | undefined
	private stopped = false
	private normaliser: ChunkNormaliser = (chunk) => chunk
	private readonly listeners: ((result: SyncResult) => void)[] = []

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: TransitRepository,
		private readonly networks: NetworksService,
		private readonly providers: ProvidersRegistry,
	) {}

	setNormaliser(normaliser: ChunkNormaliser): void {
		this.normaliser = normaliser
	}

	/** Called after every finished sync (pack builder, caches). */
	onSynced(listener: (result: SyncResult) => void): void {
		this.listeners.push(listener)
	}

	onApplicationBootstrap(): void {
		if (this.config.mode === "tracker" || this.config.transit.syncAt === null) return
		// Bindings without any static data get one right away, then the daily schedule.
		this.bootTimer = setTimeout(() => {
			this.syncMissing().catch((error: unknown) =>
				this.logger.warn(`boot sync failed: ${(error as Error).message}`),
			)
		}, 1000)
		this.bootTimer.unref?.()
		this.schedule()
	}

	onApplicationShutdown(): void {
		this.stopped = true
		if (this.timer) clearTimeout(this.timer)
		if (this.bootTimer) clearTimeout(this.bootTimer)
	}

	private schedule(): void {
		const at = this.config.transit.syncAt
		if (at === null) return
		const nowS = Math.floor(Date.now() / 1000)
		const local = localTime(nowS, "Europe/Istanbul")
		let wait = at - local.secondsOfDay
		if (wait <= 0) wait += 86400
		this.timer = setTimeout(() => {
			void this.syncAll("schedule").finally(() => this.schedule())
		}, wait * 1000)
		this.timer.unref?.()
	}

	private async syncMissing(): Promise<void> {
		for (const row of this.networks.bindingsWithContext()) {
			if (this.stopped) return
			if (this.repository.activeVersion(row.binding.id)) continue
			const effective = this.networks.effectiveBinding(row.binding, row.provider)
			if (!effective.enabled) continue
			await this.sync(row.binding.id, "boot").catch(() => undefined)
		}
	}

	async syncAll(trigger: "schedule" | "manual"): Promise<SyncResult[]> {
		const results: SyncResult[] = []
		for (const row of this.networks.bindingsWithContext()) {
			const effective = this.networks.effectiveBinding(row.binding, row.provider)
			if (!effective.enabled || row.binding.status === "disabled") continue
			results.push(
				await this.sync(row.binding.id, trigger).catch((e: unknown) =>
					this.failed(row.binding.id, e),
				),
			)
		}
		return results
	}

	private failed(bindingId: number, error: unknown): SyncResult {
		return {
			binding_id: bindingId,
			run_id: 0,
			status: "failed",
			version_id: null,
			counts: {},
			warnings: [],
			error: (error as Error).message,
		}
	}

	/** One sync per binding at a time; a second call joins the running one. */
	sync(bindingId: number, trigger: "schedule" | "manual" | "boot"): Promise<SyncResult> {
		const existing = this.running.get(bindingId)
		if (existing) return existing
		const promise = this.run(bindingId, trigger).finally(() => this.running.delete(bindingId))
		this.running.set(bindingId, promise)
		return promise
	}

	isRunning(bindingId: number): boolean {
		return this.running.has(bindingId)
	}

	private async run(
		bindingId: number,
		trigger: "schedule" | "manual" | "boot",
	): Promise<SyncResult> {
		const row = this.networks.bindingsWithContext().find((r) => r.binding.id === bindingId)
		if (!row) throw new GezcezError("NOT_FOUND", "Binding not found")
		const effective = this.networks.effectiveBinding(row.binding, row.provider)
		if (!effective.enabled)
			throw new GezcezError("PROVIDER_DISABLED", effective.message ?? undefined)
		const adapter = this.providers.get(row.binding.provider_key)!
		const context = NetworksService.context(row)
		const runId = this.repository.startRun(bindingId, trigger)
		const started = Date.now()
		const warnings: string[] = []
		try {
			const bundle: StaticBundle = {
				agencies: [],
				routes: [],
				stops: [],
				patterns: [],
				services: [],
				trips: [],
			}
			for await (const raw of adapter.fetchStatic(context)) {
				const chunk = this.normaliser(raw)
				if (chunk.kind === "warning") warnings.push(chunk.message)
				else (bundle[chunk.kind] as unknown[]).push(...chunk.items)
			}
			const validated = validateBundle(bundle)
			warnings.push(...validated.warnings)
			const counts = {
				agencies: validated.bundle.agencies.length,
				routes: validated.bundle.routes.length,
				stops: validated.bundle.stops.length,
				patterns: validated.bundle.patterns.length,
				services: validated.bundle.services.length,
				trips: validated.bundle.trips.length,
				duration_ms: 0,
			}
			const sourceHash = sha256Hex(JSON.stringify(validated.bundle))
			const active = this.repository.activeVersion(bindingId)
			if (active?.source_hash === sourceHash) {
				counts.duration_ms = Date.now() - started
				const result = this.finish(
					runId,
					bindingId,
					"unchanged",
					active.version_id,
					counts,
					warnings,
				)
				this.logger.log(`binding ${bindingId}: static data unchanged`)
				return result
			}
			const versionId = this.repository.writeVersion(bindingId, validated.bundle, sourceHash)
			counts.duration_ms = Date.now() - started
			this.repository.activate(bindingId, versionId, counts)
			this.logger.log(
				`binding ${bindingId}: version ${versionId} active (${counts.routes} routes, ${counts.stops} stops, ${counts.trips} trips)`,
			)
			return this.finish(runId, bindingId, "ok", versionId, counts, warnings)
		} catch (error) {
			const message = (error as Error).message
			this.repository.finishRun(runId, {
				status: "failed",
				version_id: null,
				counts: null,
				warnings: warnings.slice(0, MAX_WARNINGS),
				error: message,
			})
			this.logger.warn(`binding ${bindingId}: static sync failed: ${message}`)
			const result = { ...this.failed(bindingId, error), run_id: runId, warnings }
			for (const listener of this.listeners) listener(result)
			throw new GezcezError("PROVIDER_UNAVAILABLE", `Static sync failed: ${message}`)
		}
	}

	private finish(
		runId: number,
		bindingId: number,
		status: "ok" | "unchanged",
		versionId: number,
		counts: Record<string, number>,
		warnings: string[],
	): SyncResult {
		this.repository.finishRun(runId, {
			status,
			version_id: versionId,
			counts,
			warnings: warnings.slice(0, MAX_WARNINGS),
			error: null,
		})
		const result: SyncResult = {
			binding_id: bindingId,
			run_id: runId,
			status,
			version_id: versionId,
			counts,
			warnings,
			error: null,
		}
		for (const listener of this.listeners) listener(result)
		return result
	}
}
