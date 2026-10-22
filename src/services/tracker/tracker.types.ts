// tracker.types.ts
// Shapes shared by the tracker engine, its worker boundary (plan 8.10) and the LiveFeedBus.
// Everything here must survive structured cloning (plain data only).

import type { BindingRuntimeState } from "@services/networks/binding-health.registry"
import type { CredentialStatus, UrlVariant } from "@services/providers/transit-provider.interface"
import type { PollOutcome } from "@schemas/vts"

/** One vehicle as the live map sees it (vehicle_state minus run bookkeeping). */
export interface LiveVehicle {
	vehicle_id: number
	binding_id: number
	external_id: string
	plate: string | null
	label: string | null
	lat_e6: number
	lon_e6: number
	bearing_d10: number | null
	speed_cms: number | null
	route_ext: string | null
	direction: number | null
	trip_ext: string | null
	stop_ext: string | null
	stop_seq: number | null
	status: number | null
	vehicle_ts: number
	feed_ts: number
	quality: number
}

/** What one accepted poll changed for a binding (plan 8.1 "snapshot diff"). */
export interface FeedUpdate {
	binding_id: number
	poll_id: number
	feed_ts: number
	upsert: LiveVehicle[]
	/** vehicle_ids that left the live feed. */
	remove: number[]
	/** True when `upsert` is the whole live set (after a kill, restart or reload). */
	reset?: boolean
}

export interface BindingStatus {
	binding_id: number
	state: BindingRuntimeState
	message: string | null
	last_feed_ts: number | null
	last_poll_at: number | null
	last_outcome: PollOutcome | null
	consecutive_failures: number
	next_poll_at: number | null
	interval_s: number | null
	url_variant: UrlVariant | null
	live_vehicles: number
	subscribers: number
	credentials: CredentialStatus | null
}

export type TrackerControlType =
	"pause" | "resume" | "poll-now" | "reload-bindings" | "reset-url" | "refresh-token"

export interface TrackerControl {
	type: TrackerControlType
	binding_id?: number
}

export interface ControlResult {
	ok: boolean
	error?: string
	status?: BindingStatus | null
}

/** Main thread to worker. */
export type MainToWorker =
	| { type: "init"; config: unknown }
	| { type: "control"; id: number; control: TrackerControl }
	| { type: "subscribers"; counts: Record<number, number> }
	| { type: "stop" }

/** Worker to main thread. */
export type WorkerToMain =
	| { type: "ready"; statuses: BindingStatus[]; live: FeedUpdate[] }
	| { type: "update"; update: FeedUpdate }
	| { type: "status"; status: BindingStatus }
	| { type: "ack"; id: number; result: ControlResult }
	| { type: "log"; binding_id: number | null; level: "info" | "warn" | "error"; message: string }
	| { type: "fatal"; message: string }
	| { type: "stopped" }
