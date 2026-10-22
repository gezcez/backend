// tracker.service.ts
// The VTS tracker engine (plan 8). One async loop per active binding: fetch, pipeline, header
// dedup, trip detection and one SQLite transaction per poll, then a diff for the LiveFeedBus.
// Runs inside the Bun Worker (MODE=all), in the main thread (MODE=tracker or
// TRACKER_RUNNER=inline) or without timers (TRACKER_RUNNER=manual, tests drive pollOnce()).

import { Injectable, Logger } from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"
import { localTime, serviceDayStart } from "@common/utils"
import type { PollOutcome } from "@schemas/vts"
import type { BindingRuntimeState } from "@services/networks/binding-health.registry"
import { NetworksService } from "@services/networks/networks.service"
import type { BindingWithContext } from "@services/networks/networks.repository"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import {
	ProviderError,
	type BindingContext,
	type UrlVariant,
	type VehicleFeed,
} from "@services/providers/transit-provider.interface"
import { runPipeline } from "./tracker.pipeline"
import { TrackerRepository, trackedToLive, type PollRecord } from "./tracker.repository"
import {
	Breaker,
	backoffDelay,
	baseInterval,
	jittered,
	startOffset,
	WATCHED_WINDOW_S,
} from "./tracker.scheduler"
import { TrackerTimetable } from "./tracker-timetable"
import type {
	BindingStatus,
	ControlResult,
	FeedUpdate,
	LiveVehicle,
	TrackerControl,
} from "./tracker.types"
import { RESTART_GAP_S, TripDetector, type RunEvent, type TrackedVehicle } from "./trip-detector"

export interface PollSummary {
	binding_id: number
	outcome: PollOutcome
	poll_id: number | null
	feed_ts: number | null
	accepted: number
	inserted: number
	opened: number
	closed: number
}

interface Runtime {
	id: number
	row: BindingWithContext
	context: BindingContext
	/** Kill switch reason (env, provider or binding disabled). */
	killed: string | null
	/** Manual pause from the dashboard or binding status "paused". */
	paused: string | null
	pausedByStatus: boolean
	breaker: Breaker
	vehicles: Map<string, TrackedVehicle>
	detector: TripDetector
	lastFeedTs: number | null
	lastPollAt: number | null
	lastOutcome: PollOutcome | null
	lastFeedVariant: UrlVariant | null
	retryAfterS: number | undefined
	vehiclesInLastPoll: number
	intervalS: number | null
	nextPollAt: number | null
	timer: ReturnType<typeof setTimeout> | undefined
	running: Promise<PollSummary> | null
	abort: AbortController | null
	subscribers: number
	watchedUntil: number
}

export interface TrackerStartOptions {
	/** Start the per-binding loops (false for TRACKER_RUNNER=manual). */
	schedule: boolean
	/** Keep the event loop alive with the poll timers (true inside the worker). */
	refTimers?: boolean
}

const RETENTION_AT_S = 5 * 3600
const KEEP_POLLS_DAYS = 30
const KEEP_RUNS_DAYS = 30

function outcomeOf(error: unknown): PollOutcome {
	if (!(error instanceof ProviderError)) return "upstream_error"
	switch (error.kind) {
		case "decode_error":
			return "decode_error"
		case "timeout":
			return "timeout"
		case "empty":
			return "empty"
		case "auth":
		case "auth_failed":
			return "auth_error"
		case "rate_limited":
			return "rate_limited"
		case "disabled":
			return "skipped_killed"
		default:
			return "upstream_error"
	}
}

function changed(before: LiveVehicle | undefined, after: LiveVehicle): boolean {
	return (
		!before ||
		before.vehicle_ts !== after.vehicle_ts ||
		before.trip_ext !== after.trip_ext ||
		before.route_ext !== after.route_ext ||
		before.stop_seq !== after.stop_seq ||
		before.status !== after.status ||
		before.quality !== after.quality
	)
}

@Injectable()
export class TrackerService {
	private readonly logger = new Logger("Tracker")
	private readonly runtimes = new Map<number, Runtime>()
	private readonly updateListeners: ((update: FeedUpdate) => void)[] = []
	private readonly statusListeners: ((status: BindingStatus) => void)[] = []
	private readonly logListeners: ((
		bindingId: number | null,
		level: "info" | "warn" | "error",
		message: string,
	) => void)[] = []
	private options: TrackerStartOptions = { schedule: false }
	private started = false
	private stopped = false
	private retentionTimer: ReturnType<typeof setTimeout> | undefined
	random: () => number = Math.random
	now: () => number = Date.now

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: TrackerRepository,
		private readonly networks: NetworksService,
		private readonly providers: ProvidersRegistry,
		private readonly timetable: TrackerTimetable,
	) {}

	// ---- events -------------------------------------------------------------------------------

	onUpdate(listener: (update: FeedUpdate) => void): void {
		this.updateListeners.push(listener)
	}

	onStatus(listener: (status: BindingStatus) => void): void {
		this.statusListeners.push(listener)
	}

	onLog(
		listener: (
			bindingId: number | null,
			level: "info" | "warn" | "error",
			message: string,
		) => void,
	): void {
		this.logListeners.push(listener)
	}

	private emitUpdate(update: FeedUpdate): void {
		for (const listener of this.updateListeners) listener(update)
	}

	private emitStatus(rt: Runtime): void {
		const status = this.status(rt)
		for (const listener of this.statusListeners) listener(status)
	}

	private log(bindingId: number | null, level: "info" | "warn" | "error", message: string) {
		if (level === "error") this.logger.error(message)
		else if (level === "warn") this.logger.warn(message)
		else this.logger.log(message)
		for (const listener of this.logListeners) listener(bindingId, level, message)
	}

	private nowS(): number {
		return Math.floor(this.now() / 1000)
	}

	// ---- lifecycle ----------------------------------------------------------------------------

	start(options: TrackerStartOptions): void {
		if (this.started) return
		this.started = true
		this.options = options
		this.reloadBindings()
		if (options.schedule) this.scheduleRetention()
		this.log(
			null,
			"info",
			`tracker started with ${this.runtimes.size} bindings (${options.schedule ? "scheduled" : "manual"})`,
		)
	}

	async stop(): Promise<void> {
		this.stopped = true
		if (this.retentionTimer) clearTimeout(this.retentionTimer)
		const running: Promise<unknown>[] = []
		for (const rt of this.runtimes.values()) {
			if (rt.timer) clearTimeout(rt.timer)
			rt.timer = undefined
			rt.abort?.abort()
			if (rt.running) running.push(rt.running.catch(() => undefined))
		}
		await Promise.all(running)
	}

	/** Reads bindings from core.db and applies kill, pause and new bindings (plan 8.9). */
	reloadBindings(): void {
		const rows = this.networks.bindingsWithContext()
		const seen = new Set<number>()
		for (const row of rows) {
			seen.add(row.binding.id)
			const kill =
				this.networks.killReason(row.binding, row.provider) ??
				(this.providers.get(row.binding.provider_key) ? null : "No adapter for provider")
			const pausedByStatus =
				row.binding.status === "paused"
					? (row.binding.disabled_reason ?? "Paused by an operator")
					: null
			let rt = this.runtimes.get(row.binding.id)
			if (!rt) {
				rt = this.createRuntime(row)
				this.runtimes.set(rt.id, rt)
				rt.paused = pausedByStatus
				rt.pausedByStatus = pausedByStatus !== null
				if (kill) this.kill(rt, kill)
				else {
					this.recover(rt)
					this.scheduleFirst(rt)
				}
				continue
			}
			rt.row = row
			rt.context = NetworksService.context(row)
			if (kill && !rt.killed) this.kill(rt, kill)
			else if (!kill && rt.killed) {
				rt.killed = null
				this.log(rt.id, "info", `binding ${rt.id}: unkilled`)
				this.recover(rt)
				this.scheduleFirst(rt)
			}
			if (pausedByStatus && !rt.paused) {
				rt.pausedByStatus = true
				this.pause(rt, pausedByStatus)
			} else if (!pausedByStatus && rt.pausedByStatus) {
				rt.pausedByStatus = false
				this.resume(rt)
			}
			this.emitStatus(rt)
		}
		for (const rt of this.runtimes.values()) {
			if (!seen.has(rt.id) && !rt.killed) this.kill(rt, "Binding removed")
		}
	}

	private createRuntime(row: BindingWithContext): Runtime {
		const context = NetworksService.context(row)
		const id = row.binding.id
		const vehicles = new Map(this.repository.loadVehicles(id).map((v) => [v.externalId, v]))
		return {
			id,
			row,
			context,
			killed: null,
			paused: null,
			pausedByStatus: false,
			breaker: new Breaker(),
			vehicles,
			detector: new TripDetector({
				patternLength: (route, direction) =>
					this.timetable.patternLength(id, route, direction),
				schedule: (run, vehicleTs) =>
					this.timetable.match(id, context.timezone, run, vehicleTs),
			}),
			lastFeedTs: this.repository.lastAcceptedFeedTs(id),
			lastPollAt: null,
			lastOutcome: null,
			lastFeedVariant: null,
			retryAfterS: undefined,
			vehiclesInLastPoll: 0,
			intervalS: null,
			nextPollAt: null,
			timer: undefined,
			running: null,
			abort: null,
			subscribers: 0,
			watchedUntil: 0,
		}
	}

	/**
	 * Restart handling (plan 8.6): a gap under 5 min continues as if nothing happened (the
	 * missing-polls logic absorbs it); a longer gap closes open runs with `gap` at their last
	 * sample time and takes the vehicles off the live map.
	 */
	private recover(rt: Runtime): void {
		let lastSeen = 0
		for (const v of rt.vehicles.values()) lastSeen = Math.max(lastSeen, v.lastSeenFeedTs)
		if (!lastSeen || this.nowS() - lastSeen <= RESTART_GAP_S) return
		const events: RunEvent[] = []
		const touched: TrackedVehicle[] = []
		for (const v of rt.vehicles.values()) {
			if (!v.live && !v.run) continue
			events.push(...rt.detector.closeAll(v, "gap"))
			touched.push(v)
		}
		if (!touched.length) return
		this.repository.writeEvents(rt.id, events, touched, "skipped_backoff", "restart gap")
		this.emitUpdate({
			binding_id: rt.id,
			poll_id: 0,
			feed_ts: rt.lastFeedTs ?? 0,
			upsert: [],
			remove: touched.map((v) => v.vehicleId),
			reset: true,
		})
		this.log(
			rt.id,
			"info",
			`binding ${rt.id}: restart gap of ${this.nowS() - lastSeen} s, closed ${events.length} runs`,
		)
	}

	private kill(rt: Runtime, reason: string): void {
		rt.killed = reason
		if (rt.timer) clearTimeout(rt.timer)
		rt.timer = undefined
		rt.nextPollAt = null
		rt.abort?.abort()
		const events: RunEvent[] = []
		const touched: TrackedVehicle[] = []
		for (const v of rt.vehicles.values()) {
			if (!v.live && !v.run) continue
			events.push(...rt.detector.closeAll(v, "killed"))
			touched.push(v)
		}
		if (touched.length)
			this.repository.writeEvents(rt.id, events, touched, "skipped_killed", reason)
		this.emitUpdate({
			binding_id: rt.id,
			poll_id: 0,
			feed_ts: rt.lastFeedTs ?? 0,
			upsert: [],
			remove: touched.map((v) => v.vehicleId),
			reset: true,
		})
		this.log(rt.id, "warn", `binding ${rt.id}: killed (${reason})`)
		this.emitStatus(rt)
	}

	private pause(rt: Runtime, reason: string): void {
		rt.paused = reason
		if (rt.timer) clearTimeout(rt.timer)
		rt.timer = undefined
		rt.nextPollAt = null
		this.log(rt.id, "info", `binding ${rt.id}: paused`)
		this.emitStatus(rt)
	}

	private resume(rt: Runtime): void {
		rt.paused = null
		rt.pausedByStatus = false
		this.recover(rt)
		this.log(rt.id, "info", `binding ${rt.id}: resumed`)
		this.scheduleAt(rt, 0)
		this.emitStatus(rt)
	}

	// ---- scheduling ---------------------------------------------------------------------------

	private interval(rt: Runtime): number {
		return baseInterval({
			pollIntervalS: rt.row.binding.poll_interval_s,
			idlePollIntervalS: rt.row.binding.idle_poll_interval_s,
			watched: rt.subscribers > 0 || this.nowS() < rt.watchedUntil,
			localSecondsOfDay: localTime(this.nowS(), rt.context.timezone).secondsOfDay,
			quietHours: this.config.transit.quietHours,
			vehiclesInLastPoll: rt.vehiclesInLastPoll,
		})
	}

	private scheduleFirst(rt: Runtime): void {
		if (rt.paused) {
			this.emitStatus(rt)
			return
		}
		const interval = this.interval(rt)
		rt.intervalS = interval
		this.scheduleAt(rt, startOffset(rt.id, Math.min(interval, 30)))
	}

	private scheduleAt(rt: Runtime, delayS: number): void {
		if (!this.options.schedule || this.stopped || rt.killed || rt.paused) return
		if (rt.timer) clearTimeout(rt.timer)
		rt.nextPollAt = this.nowS() + Math.round(delayS)
		rt.timer = setTimeout(() => void this.tick(rt), Math.max(0, delayS * 1000))
		if (!this.options.refTimers) rt.timer.unref?.()
	}

	private async tick(rt: Runtime): Promise<void> {
		rt.timer = undefined
		if (this.stopped || rt.killed || rt.paused) return
		const startedAt = this.now()
		let failed = false
		try {
			const summary = await this.pollOnce(rt.id)
			failed = !["ok", "empty", "duplicate_header", "skipped_backoff"].includes(
				summary.outcome,
			)
		} catch (error) {
			failed = true
			this.log(rt.id, "error", `binding ${rt.id}: poll crashed: ${(error as Error).message}`)
		}
		const interval = this.interval(rt)
		rt.intervalS = interval
		const delay = failed
			? backoffDelay(interval, rt.breaker.failures, this.random(), rt.retryAfterS)
			: jittered(interval, this.random())
		// Next run = last start + delay.
		const elapsed = (this.now() - startedAt) / 1000
		this.scheduleAt(rt, Math.max(1, delay - elapsed))
		this.emitStatus(rt)
	}

	/** Subscriber counts per binding from the WS gateway (plan 8.2 adaptive interval). */
	setSubscribers(counts: Record<number, number>): void {
		const nowS = this.nowS()
		for (const rt of this.runtimes.values()) {
			const before = rt.subscribers > 0 || nowS < rt.watchedUntil
			rt.subscribers = counts[rt.id] ?? 0
			if (rt.subscribers > 0) rt.watchedUntil = nowS + WATCHED_WINDOW_S
			// Someone started watching an idle binding: poll at the active rate from now.
			if (!before && rt.subscribers > 0 && rt.nextPollAt !== null && rt.running === null) {
				const active = jittered(Math.max(15, rt.row.binding.poll_interval_s), this.random())
				if (rt.nextPollAt - nowS > active) this.scheduleAt(rt, active)
			}
		}
	}

	/** Marks a binding as recently requested (REST departures/vehicles keep it "watched"). */
	touch(bindingId: number): void {
		const rt = this.runtimes.get(bindingId)
		if (rt) rt.watchedUntil = this.nowS() + WATCHED_WINDOW_S
	}

	// ---- polling ------------------------------------------------------------------------------

	private record(rt: Runtime, partial: Partial<PollRecord> & { outcome: PollOutcome }): number {
		return this.repository.recordPoll({
			binding_id: rt.id,
			started_at: this.nowS(),
			duration_ms: 0,
			url_variant: null,
			http_status: null,
			feed_ts: null,
			entities: 0,
			accepted: 0,
			dropped: null,
			error: null,
			...partial,
		})
	}

	private summary(rt: Runtime, outcome: PollOutcome, pollId: number | null): PollSummary {
		return {
			binding_id: rt.id,
			outcome,
			poll_id: pollId,
			feed_ts: null,
			accepted: 0,
			inserted: 0,
			opened: 0,
			closed: 0,
		}
	}

	/** One poll of one binding. Concurrent calls for the same binding record `skipped_backoff`. */
	async pollOnce(bindingId: number): Promise<PollSummary> {
		const rt = this.runtimes.get(bindingId)
		if (!rt) throw new Error(`binding ${bindingId} is not tracked`)
		if (rt.killed) {
			return this.summary(
				rt,
				"skipped_killed",
				this.record(rt, { outcome: "skipped_killed" }),
			)
		}
		if (rt.running) {
			return this.summary(
				rt,
				"skipped_backoff",
				this.record(rt, {
					outcome: "skipped_backoff",
					error: "previous poll still running",
				}),
			)
		}
		const running = this.doPoll(rt).finally(() => {
			rt.running = null
			rt.abort = null
		})
		rt.running = running
		return running
	}

	private async doPoll(rt: Runtime): Promise<PollSummary> {
		const adapter = this.providers.get(rt.row.binding.provider_key)
		if (!adapter) throw new Error(`no adapter for ${rt.row.binding.provider_key}`)
		const started = this.now()
		rt.lastPollAt = Math.floor(started / 1000)
		rt.abort = new AbortController()
		let feed: VehicleFeed
		try {
			feed = await adapter.fetchVehicles(rt.context, rt.abort.signal)
		} catch (error) {
			if (rt.abort.signal.aborted && (this.stopped || rt.killed))
				return this.summary(rt, "skipped_killed", null)
			return this.failure(rt, error, started)
		}
		rt.retryAfterS = undefined
		rt.lastFeedVariant = feed.urlVariant
		const base = {
			started_at: Math.floor(started / 1000),
			url_variant: feed.urlVariant,
			http_status: 200,
			feed_ts: feed.feedTs,
			entities: feed.entities.length,
		}
		// Header-level dedup: the same feed timestamp means nothing new upstream.
		if (rt.lastFeedTs !== null && feed.feedTs === rt.lastFeedTs && feed.entities.length) {
			const pollId = this.record(rt, {
				...base,
				outcome: "duplicate_header",
				duration_ms: this.now() - started,
			})
			this.success(rt, "duplicate_header")
			return { ...this.summary(rt, "duplicate_header", pollId), feed_ts: feed.feedTs }
		}

		const { samples, dropped } = runPipeline({
			feed,
			binding: rt.context,
			classify: (vehicle) => adapter.classify?.(vehicle, rt.context) ?? null,
			previous: (externalId) => {
				const v = rt.vehicles.get(externalId)
				return v
					? {
							latE6: v.sample.latE6,
							lonE6: v.sample.lonE6,
							vehicleTs: v.sample.vehicleTs,
							tripExt: v.sample.tripExt,
							runStartedAt: v.run?.startedAt ?? null,
						}
					: undefined
			},
		})
		const outcome: PollOutcome = feed.entities.length ? "ok" : "empty"
		const before = new Map<number, LiveVehicle>()
		const wasLive = new Set<number>()
		for (const v of rt.vehicles.values()) {
			if (v.live) {
				wasLive.add(v.vehicleId)
				before.set(v.vehicleId, trackedToLive(v))
			}
		}
		let result
		try {
			result = this.repository.writePoll(
				{
					...base,
					binding_id: rt.id,
					duration_ms: this.now() - started,
					outcome,
					accepted: samples.length,
					dropped,
					error: null,
				},
				samples,
				(ids) => {
					const events: RunEvent[] = []
					const touched: TrackedVehicle[] = []
					const present = new Set<string>()
					for (const sample of samples) {
						present.add(sample.externalId)
						let v = rt.vehicles.get(sample.externalId)
						if (!v) {
							v = {
								vehicleId: ids.get(sample.externalId)!,
								bindingId: rt.id,
								externalId: sample.externalId,
								sample,
								feedTs: feed.feedTs,
								live: true,
								run: null,
								lastSeenFeedTs: feed.feedTs,
								missingPolls: 0,
							}
							rt.vehicles.set(sample.externalId, v)
						}
						events.push(...rt.detector.present(v, sample, feed.feedTs))
						touched.push(v)
					}
					for (const v of rt.vehicles.values()) {
						if (present.has(v.externalId) || !v.live) continue
						events.push(...rt.detector.absent(v, feed.feedTs))
						touched.push(v)
					}
					return { events, touched }
				},
			)
		} catch (error) {
			// Memory may be ahead of the rolled back transaction: reload from vts.db.
			rt.vehicles = new Map(this.repository.loadVehicles(rt.id).map((v) => [v.externalId, v]))
			this.log(rt.id, "error", `binding ${rt.id}: write failed: ${(error as Error).message}`)
			throw error
		}
		rt.lastFeedTs = feed.feedTs
		rt.vehiclesInLastPoll = samples.length
		this.success(rt, outcome)

		const upsert: LiveVehicle[] = []
		const remove: number[] = []
		for (const v of result.touched) {
			if (v.live) {
				const live = trackedToLive(v)
				if (changed(before.get(v.vehicleId), live)) upsert.push(live)
			} else if (wasLive.has(v.vehicleId)) remove.push(v.vehicleId)
		}
		if (upsert.length || remove.length) {
			this.emitUpdate({
				binding_id: rt.id,
				poll_id: result.pollId,
				feed_ts: feed.feedTs,
				upsert,
				remove,
			})
		}
		return {
			binding_id: rt.id,
			outcome,
			poll_id: result.pollId,
			feed_ts: feed.feedTs,
			accepted: samples.length,
			inserted: result.inserted,
			opened: result.events.filter((e) => e.kind === "open").length,
			closed: result.events.filter((e) => e.kind === "close").length,
		}
	}

	private success(rt: Runtime, outcome: PollOutcome): void {
		rt.lastOutcome = outcome
		const { changed: stateChanged } = rt.breaker.success()
		if (stateChanged) this.log(rt.id, "info", `binding ${rt.id}: ok`)
	}

	private failure(rt: Runtime, error: unknown, started: number): PollSummary {
		const outcome = outcomeOf(error)
		const details = error instanceof ProviderError ? error.details : {}
		const message = (error as Error).message
		rt.lastOutcome = outcome
		rt.retryAfterS = details.retryAfterS
		const pollId = this.record(rt, {
			started_at: Math.floor(started / 1000),
			duration_ms: this.now() - started,
			outcome,
			url_variant: details.urlVariant ?? null,
			http_status: details.httpStatus ?? null,
			error: message.slice(0, 500),
		})
		const fatal = error instanceof ProviderError && error.kind === "auth_failed"
		const { changed: stateChanged } = rt.breaker.failure(this.nowS(), message, fatal)
		if (stateChanged)
			this.log(rt.id, "warn", `binding ${rt.id}: ${rt.breaker.state} (${message})`)
		return this.summary(rt, outcome, pollId)
	}

	// ---- status and control -------------------------------------------------------------------

	private state(rt: Runtime): BindingRuntimeState {
		if (rt.killed) return "killed"
		if (rt.paused) return "paused"
		return rt.breaker.state
	}

	status(rt: Runtime): BindingStatus {
		const adapter = this.providers.get(rt.row.binding.provider_key)
		let live = 0
		for (const v of rt.vehicles.values()) if (v.live) live++
		return {
			binding_id: rt.id,
			state: this.state(rt),
			message: rt.killed ?? rt.paused ?? rt.breaker.message,
			last_feed_ts: rt.lastFeedTs,
			last_poll_at: rt.lastPollAt,
			last_outcome: rt.lastOutcome,
			consecutive_failures: rt.breaker.failures,
			next_poll_at: rt.nextPollAt,
			interval_s: rt.intervalS,
			url_variant: rt.lastFeedVariant,
			live_vehicles: live,
			subscribers: rt.subscribers,
			credentials: adapter?.credentialStatus?.(rt.context) ?? null,
		}
	}

	statuses(): BindingStatus[] {
		return [...this.runtimes.values()].map((rt) => this.status(rt))
	}

	/** The whole live set per binding (worker "ready" and resync after a reset). */
	liveSets(): FeedUpdate[] {
		return [...this.runtimes.values()].map((rt) => ({
			binding_id: rt.id,
			poll_id: 0,
			feed_ts: rt.lastFeedTs ?? 0,
			upsert: [...rt.vehicles.values()].filter((v) => v.live).map(trackedToLive),
			remove: [],
			reset: true,
		}))
	}

	async control(control: TrackerControl): Promise<ControlResult> {
		if (control.type === "reload-bindings") {
			this.reloadBindings()
			return { ok: true }
		}
		const rt =
			control.binding_id !== undefined ? this.runtimes.get(control.binding_id) : undefined
		if (!rt) return { ok: false, error: "Binding is not tracked" }
		switch (control.type) {
			case "pause":
				if (!rt.paused) this.pause(rt, "Paused by an operator")
				break
			case "resume":
				if (rt.paused) this.resume(rt)
				break
			case "poll-now": {
				if (rt.killed) return { ok: false, error: rt.killed, status: this.status(rt) }
				const summary = await this.pollOnce(rt.id)
				if (this.options.schedule && !rt.paused) {
					const interval = this.interval(rt)
					this.scheduleAt(rt, jittered(interval, this.random()))
				}
				this.emitStatus(rt)
				return {
					ok: !["upstream_error", "decode_error", "timeout", "auth_error"].includes(
						summary.outcome,
					),
					error: summary.outcome,
					status: this.status(rt),
				}
			}
			case "reset-url":
				this.providers.get(rt.row.binding.provider_key)?.resetUrlVariant?.(rt.context)
				break
			case "refresh-token": {
				const adapter = this.providers.get(rt.row.binding.provider_key)
				if (!adapter?.refreshCredentials)
					return { ok: false, error: "Provider has no credentials" }
				try {
					await adapter.refreshCredentials(rt.context)
				} catch (error) {
					return { ok: false, error: (error as Error).message, status: this.status(rt) }
				}
				break
			}
		}
		this.emitStatus(rt)
		return { ok: true, status: this.status(rt) }
	}

	// ---- retention (plan 8.7) -----------------------------------------------------------------

	private scheduleRetention(): void {
		const local = localTime(this.nowS(), "Europe/Istanbul").secondsOfDay
		let wait = RETENTION_AT_S - local
		if (wait <= 0) wait += 86400
		this.retentionTimer = setTimeout(() => {
			try {
				this.runRetention()
			} catch (error) {
				this.log(null, "error", `retention failed: ${(error as Error).message}`)
			}
			if (!this.stopped) this.scheduleRetention()
		}, wait * 1000)
		if (!this.options.refTimers) this.retentionTimer.unref?.()
	}

	/**
	 * Deletes positions older than VTS_HOT_DAYS, by UTC day, only for days whose archive is
	 * verified and uploaded (unless VTS_RETENTION_REQUIRE_ARCHIVE=false). polls and closed runs
	 * are kept 30 days.
	 */
	runRetention(nowS = this.nowS()): { positions: number; polls: number; runs: number } {
		const cutoffDay = serviceDayStart(nowS - this.config.transit.hotDays * 86400, "UTC")
		let positions = 0
		for (const rt of this.runtimes.values()) {
			const oldest = this.repository.oldestPositionTs(rt.id)
			if (oldest === null || oldest >= cutoffDay) continue
			const archived = this.config.transit.retentionRequireArchive
				? this.repository.archivedDates(rt.id)
				: null
			for (let day = serviceDayStart(oldest, "UTC"); day < cutoffDay; day += 86400) {
				const date = new Date(day * 1000).toISOString().slice(0, 10)
				if (archived && !archived.has(date)) continue
				positions += this.repository.deletePositions(rt.id, day, day + 86400)
			}
		}
		const polls = this.repository.deleteOldPolls(nowS - KEEP_POLLS_DAYS * 86400)
		const runs = this.repository.deleteOldRuns(nowS - KEEP_RUNS_DAYS * 86400)
		this.repository.incrementalVacuum()
		if (positions || polls || runs)
			this.log(
				null,
				"info",
				`retention: ${positions} positions, ${polls} polls, ${runs} runs`,
			)
		return { positions, polls, runs }
	}
}
