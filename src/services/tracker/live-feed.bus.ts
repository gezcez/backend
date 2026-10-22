// live-feed.bus.ts
// Main-thread live vehicle map per binding (plan 3.1 LiveFeedBus). Fed by the tracker (worker
// messages or the in-process engine) or, with MODE=api, by the vehicle_state change feed. The WS
// gateway and the REST snapshot read from here; nothing here touches upstream.

import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"
import { TrackerRepository, stateToLive } from "./tracker.repository"
import type { FeedUpdate, LiveVehicle } from "./tracker.types"

export type FeedListener = (update: FeedUpdate) => void

@Injectable()
export class LiveFeedBus implements OnApplicationBootstrap {
	private readonly live = new Map<number, Map<number, LiveVehicle>>()
	private readonly feedTs = new Map<number, number>()
	private readonly listeners = new Set<FeedListener>()

	constructor(private readonly repository: TrackerRepository) {}

	onApplicationBootstrap(): void {
		this.reload()
	}

	/** Replaces the whole map with vehicle_state rows that are live (boot, MODE=api resync). */
	reload(): void {
		this.live.clear()
		for (const row of this.repository.liveVehicles()) {
			this.bucket(row.binding_id).set(row.vehicle_id, stateToLive(row))
			this.feedTs.set(
				row.binding_id,
				Math.max(this.feedTs.get(row.binding_id) ?? 0, row.feed_ts),
			)
		}
	}

	private bucket(bindingId: number): Map<number, LiveVehicle> {
		let map = this.live.get(bindingId)
		if (!map) {
			map = new Map()
			this.live.set(bindingId, map)
		}
		return map
	}

	apply(update: FeedUpdate): void {
		const map = this.bucket(update.binding_id)
		if (update.reset) map.clear()
		for (const id of update.remove) map.delete(id)
		for (const vehicle of update.upsert) map.set(vehicle.vehicle_id, vehicle)
		if (update.feed_ts) this.feedTs.set(update.binding_id, update.feed_ts)
		for (const listener of this.listeners) listener(update)
	}

	subscribe(listener: FeedListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	vehicles(bindingId: number): LiveVehicle[] {
		return [...(this.live.get(bindingId)?.values() ?? [])]
	}

	vehicle(bindingId: number, vehicleId: number): LiveVehicle | undefined {
		return this.live.get(bindingId)?.get(vehicleId)
	}

	byExternalId(bindingId: number, externalId: string): LiveVehicle | undefined {
		for (const v of this.live.get(bindingId)?.values() ?? [])
			if (v.external_id === externalId) return v
		return undefined
	}

	lastFeedTs(bindingId: number): number | null {
		return this.feedTs.get(bindingId) ?? null
	}

	count(bindingId: number): number {
		return this.live.get(bindingId)?.size ?? 0
	}
}
