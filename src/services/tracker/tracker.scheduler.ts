// tracker.scheduler.ts
// Per-binding scheduling, backoff and the circuit breaker (plan 8.2 and 8.3). Pure helpers plus a
// small breaker state machine; the engine owns the timers.

import type { BindingRuntimeState } from "@services/networks/binding-health.registry"

export const MIN_INTERVAL_S = 15
export const QUIET_INTERVAL_S = 300
export const MAX_BACKOFF_S = 15 * 60
export const DEGRADED_AFTER_FAILURES = 3
export const DOWN_AFTER_S = 15 * 60
/** Subscribers or departures requests within this window count as "watched". */
export const WATCHED_WINDOW_S = 5 * 60

export interface IntervalInput {
	pollIntervalS: number
	idlePollIntervalS: number
	watched: boolean
	/** Seconds after local midnight in the binding's time zone. */
	localSecondsOfDay: number
	quietHours: { start: number; end: number } | null
	vehiclesInLastPoll: number
}

export function inQuietHours(secondsOfDay: number, quiet: { start: number; end: number } | null) {
	if (!quiet) return false
	return quiet.start <= quiet.end
		? secondsOfDay >= quiet.start && secondsOfDay < quiet.end
		: secondsOfDay >= quiet.start || secondsOfDay < quiet.end
}

/** Base interval before jitter: active, idle or quiet hours; never below the 15 s floor. */
export function baseInterval(input: IntervalInput): number {
	const configured = input.watched ? input.pollIntervalS : input.idlePollIntervalS
	let interval = Math.max(MIN_INTERVAL_S, configured)
	if (inQuietHours(input.localSecondsOfDay, input.quietHours) && input.vehiclesInLastPoll === 0)
		interval = Math.max(interval, QUIET_INTERVAL_S)
	return interval
}

/** `interval * jitter(0.9..1.1)`; `random` in [0, 1). */
export function jittered(intervalS: number, random: number): number {
	return Math.max(MIN_INTERVAL_S, intervalS * (0.9 + 0.2 * random))
}

/** `min(interval * 2^failures, 15 min)` with full jitter, honouring Retry-After. */
export function backoffDelay(
	intervalS: number,
	failures: number,
	random: number,
	retryAfterS?: number,
): number {
	const cap = Math.min(intervalS * 2 ** Math.min(failures, 16), MAX_BACKOFF_S)
	const delay = Math.max(MIN_INTERVAL_S, cap * random)
	return retryAfterS !== undefined ? Math.max(delay, Math.min(retryAfterS, MAX_BACKOFF_S)) : delay
}

/** Stable stagger so bindings do not all poll in the same second: hash(id) % interval. */
export function startOffset(bindingId: number, intervalS: number): number {
	let h = 2166136261
	for (const ch of String(bindingId)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
	return (h >>> 0) % Math.max(1, Math.floor(intervalS))
}

export type BreakerState = Extract<BindingRuntimeState, "ok" | "degraded" | "down" | "unknown">

/** ok, degraded after 3 consecutive failures, down after 15 min of failures. */
export class Breaker {
	failures = 0
	firstFailureAt: number | null = null
	state: BreakerState = "unknown"
	message: string | null = null

	success(): { changed: boolean } {
		const changed = this.state !== "ok"
		this.failures = 0
		this.firstFailureAt = null
		this.state = "ok"
		this.message = null
		return { changed }
	}

	failure(nowS: number, message: string, fatal = false): { changed: boolean } {
		const before = this.state
		this.failures++
		this.firstFailureAt ??= nowS
		this.message = message
		if (fatal || nowS - this.firstFailureAt >= DOWN_AFTER_S) this.state = "down"
		else if (this.failures >= DEGRADED_AFTER_FAILURES) this.state = "degraded"
		return { changed: before !== this.state }
	}
}
