// tracker-host.service.ts
// Runs the tracker for this process and connects it to the LiveFeedBus (plan 3.1 and 8.10):
// - MODE=all, TRACKER_RUNNER=worker: a Bun Worker, restarted with backoff (1 s, 5 s, 30 s);
// - MODE=tracker or TRACKER_RUNNER=inline: the engine in this thread with timers;
// - TRACKER_RUNNER=manual: the engine without timers (tests call pollOnce / poll-now);
// - MODE=api: no tracker; vehicle_state rows changed since the last seen poll every 2 s;
// - TRACKER_RUNNER=off: nothing (the bus keeps what vts.db had at boot).
// It also publishes per-binding health for the catalog and a readiness check.

import {
	Injectable,
	Logger,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common"
import { ModuleRef } from "@nestjs/core"
import { InjectConfig, type AppConfig } from "@common/config"
import { BindingHealthRegistry } from "@services/networks/binding-health.registry"
import { NetworksService } from "@services/networks/networks.service"
import { SystemService } from "@services/system/system.service"
import { LiveFeedBus } from "./live-feed.bus"
import { TrackerRepository, stateToLive } from "./tracker.repository"
import { TrackerService } from "./tracker.service"
import type {
	BindingStatus,
	ControlResult,
	FeedUpdate,
	MainToWorker,
	TrackerControl,
	WorkerToMain,
} from "./tracker.types"

export type TrackerRunner = "worker" | "inline" | "manual" | "external" | "off"

const RESTART_BACKOFF_MS = [1000, 5000, 30_000]
const CONTROL_TIMEOUT_MS = 30_000
const CHANGE_FEED_MS = 2000
const LOG_RING = 500

export interface TrackerLogLine {
	at: number
	binding_id: number | null
	level: "info" | "warn" | "error"
	message: string
}

export function trackerRunner(config: AppConfig): TrackerRunner {
	if (config.mode === "api") return "external"
	if (config.mode === "tracker")
		return config.transit.trackerRunner === "manual" ? "manual" : "inline"
	return config.transit.trackerRunner
}

@Injectable()
export class TrackerHostService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = new Logger("TrackerHost")
	readonly runner: TrackerRunner
	private readonly statusMap = new Map<number, BindingStatus>()
	private readonly logs: TrackerLogLine[] = []
	private readonly logListeners = new Set<(line: TrackerLogLine) => void>()
	private readonly statusListeners = new Set<(status: BindingStatus) => void>()
	private worker: Worker | undefined
	private workerReady = false
	private restarts = 0
	private stopping = false
	private restartTimer: ReturnType<typeof setTimeout> | undefined
	private changeTimer: ReturnType<typeof setInterval> | undefined
	private lastPollId = 0
	private nextControlId = 1
	private readonly pending = new Map<
		number,
		{ resolve: (result: ControlResult) => void; timer: ReturnType<typeof setTimeout> }
	>()
	private engine: TrackerService | undefined

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly bus: LiveFeedBus,
		private readonly repository: TrackerRepository,
		private readonly health: BindingHealthRegistry,
		private readonly networks: NetworksService,
		private readonly system: SystemService,
		private readonly moduleRef: ModuleRef,
	) {
		this.runner = trackerRunner(config)
	}

	onApplicationBootstrap(): void {
		this.health.register((bindingId) => {
			const status = this.statusMap.get(bindingId)
			if (!status) return undefined
			return {
				state: status.state,
				message: status.message,
				lastFeedTs: status.last_feed_ts,
				credentials: status.credentials,
			}
		})
		this.system.registerProbe(() => ({
			name: "tracker",
			ok: this.runner !== "worker" || this.workerReady,
		}))
		this.networks.onCatalogChanged(() => {
			void this.control({ type: "reload-bindings" })
		})
		switch (this.runner) {
			case "worker":
				this.spawn()
				break
			case "inline":
			case "manual":
				this.startInline()
				break
			case "external":
				this.lastPollId = this.repository.maxPollId()
				this.changeTimer = setInterval(() => this.followChanges(), CHANGE_FEED_MS)
				this.changeTimer.unref?.()
				break
			case "off":
				break
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopping = true
		if (this.restartTimer) clearTimeout(this.restartTimer)
		if (this.changeTimer) clearInterval(this.changeTimer)
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer)
			entry.resolve({ ok: false, error: "Shutting down" })
		}
		this.pending.clear()
		await this.engine?.stop()
		const worker = this.worker
		if (worker) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					worker.terminate()
					resolve()
				}, 5000)
				worker.addEventListener("message", (event: MessageEvent<WorkerToMain>) => {
					if (event.data.type === "stopped") {
						clearTimeout(timer)
						resolve()
					}
				})
				this.post({ type: "stop" })
			})
			this.worker = undefined
		}
	}

	// ---- in-process engine --------------------------------------------------------------------

	private startInline(): void {
		const engine = this.moduleRef.get(TrackerService, { strict: false })
		this.engine = engine
		engine.onUpdate((update) => this.bus.apply(update))
		engine.onStatus((status) => this.setStatus(status))
		engine.onLog((bindingId, level, message) => this.pushLog(bindingId, level, message))
		engine.start({ schedule: this.runner === "inline" })
		for (const status of engine.statuses()) this.setStatus(status)
	}

	/** The in-process engine (inline and manual runners; tests drive it directly). */
	inlineEngine(): TrackerService | undefined {
		return this.engine
	}

	// ---- worker -------------------------------------------------------------------------------

	private spawn(): void {
		this.workerReady = false
		const worker = new Worker(new URL("../../tracker.worker.ts", import.meta.url).href)
		this.worker = worker
		worker.addEventListener("message", (event: MessageEvent<WorkerToMain>) =>
			this.onWorkerMessage(event.data),
		)
		worker.addEventListener("error", (event) => {
			this.logger.error(`tracker worker error: ${event.message}`)
		})
		worker.addEventListener("close", () => {
			if (this.worker !== worker) return
			this.worker = undefined
			this.workerReady = false
			if (this.stopping) return
			const delay =
				RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]!
			this.restarts++
			this.logger.warn(`tracker worker exited; restarting in ${delay} ms`)
			this.restartTimer = setTimeout(() => this.spawn(), delay)
		})
		this.post({ type: "init", config: this.config })
	}

	private post(message: MainToWorker): void {
		this.worker?.postMessage(message)
	}

	private onWorkerMessage(message: WorkerToMain): void {
		switch (message.type) {
			case "ready":
				this.workerReady = true
				this.restarts = 0
				for (const status of message.statuses) this.setStatus(status)
				for (const update of message.live) this.bus.apply(update)
				this.logger.log("tracker worker ready")
				break
			case "update":
				this.bus.apply(message.update)
				break
			case "status":
				this.setStatus(message.status)
				break
			case "ack": {
				const entry = this.pending.get(message.id)
				if (entry) {
					clearTimeout(entry.timer)
					this.pending.delete(message.id)
					entry.resolve(message.result)
				}
				break
			}
			case "log":
				this.pushLog(message.binding_id, message.level, message.message, false)
				break
			case "fatal":
				this.logger.error(`tracker worker failed to start: ${message.message}`)
				this.worker?.terminate()
				break
			case "stopped":
				break
		}
	}

	// ---- MODE=api change feed -----------------------------------------------------------------

	private followChanges(): void {
		try {
			const polls = this.repository.pollsAfter(this.lastPollId)
			if (!polls.length) return
			const rows = this.repository.changedSince(this.lastPollId)
			const updates = new Map<number, FeedUpdate>()
			for (const row of rows) {
				let update = updates.get(row.binding_id)
				if (!update) {
					update = {
						binding_id: row.binding_id,
						poll_id: row.updated_poll_id,
						feed_ts: 0,
						upsert: [],
						remove: [],
					}
					updates.set(row.binding_id, update)
				}
				update.feed_ts = Math.max(update.feed_ts, row.feed_ts)
				if (row.live) update.upsert.push(stateToLive(row))
				else update.remove.push(row.vehicle_id)
			}
			for (const update of updates.values()) this.bus.apply(update)
			for (const poll of polls) {
				const previous = this.statusMap.get(poll.binding_id)
				const okish = ["ok", "empty", "duplicate_header"].includes(poll.outcome)
				this.setStatus({
					binding_id: poll.binding_id,
					state:
						poll.outcome === "skipped_killed"
							? "killed"
							: okish
								? "ok"
								: (previous?.consecutive_failures ?? 0) >= 2
									? "degraded"
									: (previous?.state ?? "unknown"),
					message: poll.error,
					last_feed_ts: okish ? poll.feed_ts : (previous?.last_feed_ts ?? null),
					last_poll_at: poll.started_at,
					last_outcome: poll.outcome,
					consecutive_failures: okish ? 0 : (previous?.consecutive_failures ?? 0) + 1,
					next_poll_at: null,
					interval_s: null,
					url_variant: poll.url_variant,
					live_vehicles: this.bus.count(poll.binding_id),
					subscribers: previous?.subscribers ?? 0,
					credentials: previous?.credentials ?? null,
				})
			}
			this.lastPollId = polls[polls.length - 1]!.id
		} catch (error) {
			this.logger.warn(`vehicle_state change feed failed: ${(error as Error).message}`)
		}
	}

	// ---- shared -------------------------------------------------------------------------------

	private setStatus(status: BindingStatus): void {
		const previous = this.statusMap.get(status.binding_id)
		this.statusMap.set(status.binding_id, status)
		if (previous?.state !== status.state || previous.message !== status.message)
			for (const listener of this.statusListeners) listener(status)
	}

	private pushLog(
		bindingId: number | null,
		level: "info" | "warn" | "error",
		message: string,
		echo = false,
	): void {
		const line: TrackerLogLine = {
			at: Math.floor(Date.now() / 1000),
			binding_id: bindingId,
			level,
			message,
		}
		this.logs.push(line)
		if (this.logs.length > LOG_RING) this.logs.shift()
		if (echo) this.logger.log(message)
		for (const listener of this.logListeners) listener(line)
	}

	onStatusChange(listener: (status: BindingStatus) => void): () => void {
		this.statusListeners.add(listener)
		return () => this.statusListeners.delete(listener)
	}

	onLogLine(listener: (line: TrackerLogLine) => void): () => void {
		this.logListeners.add(listener)
		return () => this.logListeners.delete(listener)
	}

	recentLogs(bindingId?: number): TrackerLogLine[] {
		return bindingId === undefined
			? [...this.logs]
			: this.logs.filter((line) => line.binding_id === bindingId)
	}

	status(bindingId: number): BindingStatus | undefined {
		return this.statusMap.get(bindingId)
	}

	statuses(): BindingStatus[] {
		return [...this.statusMap.values()]
	}

	isRunning(): boolean {
		return this.runner === "worker" ? this.workerReady : this.runner !== "off"
	}

	/** Sends a control message and waits for the tracker's answer (plan P3 "worker ack"). */
	control(control: TrackerControl): Promise<ControlResult> {
		if (this.engine) return this.engine.control(control)
		if (this.runner !== "worker" || !this.worker)
			return Promise.resolve({
				ok: false,
				error:
					this.runner === "external"
						? "The tracker runs in another process (MODE=api)"
						: "The tracker is not running",
			})
		const id = this.nextControlId++
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				resolve({ ok: false, error: "Tracker did not answer in time" })
			}, CONTROL_TIMEOUT_MS)
			this.pending.set(id, { resolve, timer })
			this.post({ type: "control", id, control })
		})
	}

	/** Active WS subscribers per binding (adaptive polling, plan 8.2). */
	setSubscribers(counts: Record<number, number>): void {
		for (const [id, status] of this.statusMap) status.subscribers = counts[id] ?? 0
		if (this.engine) this.engine.setSubscribers(counts)
		else this.post({ type: "subscribers", counts })
	}

	/** REST reads mark a binding as watched too. */
	touch(bindingId: number): void {
		this.engine?.touch(bindingId)
	}
}
