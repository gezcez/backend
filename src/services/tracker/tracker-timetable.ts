// tracker-timetable.ts
// Static-data lookups the trip detector needs (plan 8.6): pattern length for "completed" and the
// timetable match that fills scheduled_start_s / start_delay_s. Reads transit.db (read-only in the
// worker) and caches per active version.

import { Injectable } from "@nestjs/common"
import { localTime, serviceDayStart, serviceRunsOn, type ServiceCalendar } from "@common/utils"
import { TransitRepository } from "@services/transit/transit.repository"
import type { OpenRun } from "./trip-detector"

/** Nearest scheduled start on the pattern within this window counts as a match. */
export const MATCH_WINDOW_S = 20 * 60
const VERSION_TTL_MS = 60_000

interface VersionCache {
	versionId: number
	checkedAt: number
	patternLength: Map<string, number | null>
	patternId: Map<string, number | null>
	services: (ServiceCalendar & { id: number })[]
}

@Injectable()
export class TrackerTimetable {
	private readonly cache = new Map<number, VersionCache | null>()

	constructor(private readonly transit: TransitRepository) {}

	private version(bindingId: number): VersionCache | null {
		const cached = this.cache.get(bindingId)
		const now = Date.now()
		if (cached && now - cached.checkedAt < VERSION_TTL_MS) return cached
		const active = this.transit.activeVersion(bindingId)
		if (!active) {
			this.cache.delete(bindingId)
			return null
		}
		if (cached && cached.versionId === active.version_id) {
			cached.checkedAt = now
			return cached
		}
		const next: VersionCache = {
			versionId: active.version_id,
			checkedAt: now,
			patternLength: new Map(),
			patternId: new Map(),
			services: this.transit.services(active.version_id),
		}
		this.cache.set(bindingId, next)
		return next
	}

	/** Forget cached versions (after a static sync). */
	invalidate(bindingId?: number): void {
		if (bindingId === undefined) this.cache.clear()
		else this.cache.delete(bindingId)
	}

	private pattern(cache: VersionCache, routeExt: string, direction: number | null) {
		const key = `${routeExt}|${direction ?? 0}`
		if (!cache.patternId.has(key)) {
			const pattern = this.transit.patternByRoute(cache.versionId, routeExt, direction ?? 0)
			cache.patternId.set(key, pattern?.id ?? null)
			cache.patternLength.set(key, pattern?.stop_count ?? null)
		}
		return {
			id: cache.patternId.get(key) ?? null,
			length: cache.patternLength.get(key) ?? null,
		}
	}

	patternLength(
		bindingId: number,
		routeExt: string,
		direction: number | null,
	): number | undefined {
		const cache = this.version(bindingId)
		if (!cache) return undefined
		return this.pattern(cache, routeExt, direction).length ?? undefined
	}

	/**
	 * Matches a freshly opened run to the timetable: the trip external id in the active version,
	 * else the nearest scheduled start on that pattern within 20 minutes.
	 */
	match(
		bindingId: number,
		timeZone: string,
		run: OpenRun,
		vehicleTs: number,
	): { scheduledStartS: number; startDelayS: number } | null {
		const cache = this.version(bindingId)
		if (!cache) return null
		const dayStart = serviceDayStart(vehicleTs, timeZone)
		const local = vehicleTs - dayStart
		const normalise = (delay: number) =>
			delay < -43200 ? delay + 86400 : delay > 43200 ? delay - 86400 : delay
		if (run.tripExt) {
			const trip = this.transit.tripByExternal(cache.versionId, run.tripExt)
			if (trip) {
				const delay = normalise(local - trip.start_time_s)
				if (Math.abs(delay) <= 3 * 3600)
					return { scheduledStartS: trip.start_time_s, startDelayS: delay }
			}
		}
		const pattern = this.pattern(cache, run.routeExt, run.direction)
		if (pattern.id === null) return null
		const { date } = localTime(vehicleTs, timeZone)
		const serviceIds = cache.services.filter((s) => serviceRunsOn(s, date)).map((s) => s.id)
		const trips = this.transit.tripsForPatterns([pattern.id], serviceIds, {
			from: local - MATCH_WINDOW_S,
			to: local + MATCH_WINDOW_S + 1,
		})
		let best: { scheduledStartS: number; startDelayS: number } | null = null
		for (const trip of trips) {
			const delay = local - trip.start_time_s
			if (!best || Math.abs(delay) < Math.abs(best.startDelayS))
				best = { scheduledStartS: trip.start_time_s, startDelayS: delay }
		}
		return best
	}
}
