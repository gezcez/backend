// vehicles.ts
// vts.db hot window (plan 5.3). The tracker is the only writer. Timestamps are unix seconds.

import { sql } from "drizzle-orm"
import { index, int, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/** vehicles.kind_flags bits. */
export const VEHICLE_KIND = { test: 1, staff: 2, intercity: 4 } as const

export const vehiclesTable = sqliteTable(
	"vehicles",
	{
		id: int().primaryKey({ autoIncrement: true }),
		binding_id: int().notNull(),
		external_id: text().notNull(),
		plate: text(),
		label: text(),
		kind_flags: int().notNull().default(0),
		first_seen_at: int().notNull(),
		last_seen_at: int().notNull(),
	},
	(t) => [uniqueIndex("vehicles_binding_ext_unique").on(t.binding_id, t.external_id)],
)

/** positions.quality bits (stored but not broadcast). */
export const QUALITY = {
	stale: 1,
	jump: 2,
	out_of_bbox: 4,
	speed_outlier: 8,
	frozen_trip: 16,
} as const

/**
 * One row per (vehicle, GPS fix): the PK is the dedup key. The migration declares the table
 * WITHOUT ROWID (drizzle cannot express it).
 */
export const positionsTable = sqliteTable(
	"positions",
	{
		vehicle_id: int().notNull(),
		vehicle_ts: int().notNull(),
		feed_ts: int().notNull(),
		binding_id: int().notNull(),
		route_ext: text(),
		direction: int(),
		trip_ext: text(),
		stop_ext: text(),
		stop_seq: int(),
		status: int(),
		lat_e6: int().notNull(),
		lon_e6: int().notNull(),
		bearing_d10: int(),
		speed_cms: int(),
		quality: int().notNull().default(0),
	},
	(t) => [
		primaryKey({ columns: [t.vehicle_id, t.vehicle_ts] }),
		index("positions_binding_feed_idx").on(t.binding_id, t.feed_ts),
	],
)

/** Latest state per vehicle: serves live snapshots and trip detection across restarts. */
export const vehicleStateTable = sqliteTable(
	"vehicle_state",
	{
		vehicle_id: int().primaryKey(),
		binding_id: int().notNull(),
		external_id: text().notNull(),
		plate: text(),
		label: text(),
		vehicle_ts: int().notNull(),
		feed_ts: int().notNull(),
		lat_e6: int().notNull(),
		lon_e6: int().notNull(),
		bearing_d10: int(),
		speed_cms: int(),
		route_ext: text(),
		direction: int(),
		trip_ext: text(),
		stop_ext: text(),
		stop_seq: int(),
		status: int(),
		quality: int().notNull().default(0),
		/** 1 while the vehicle is part of the live feed (removed after it disappears). */
		live: int().notNull().default(1),
		open_run_id: int(),
		run_trip_ext: text(),
		run_route_ext: text(),
		run_direction: int(),
		run_started_at: int(),
		run_last_ts: int(),
		run_first_stop_seq: int(),
		run_last_stop_seq: int(),
		run_samples: int(),
		last_seen_feed_ts: int().notNull(),
		missing_polls: int().notNull().default(0),
		max_stop_seq: int(),
		updated_poll_id: int().notNull(),
	},
	(t) => [
		index("vehicle_state_binding_idx").on(t.binding_id),
		index("vehicle_state_poll_idx").on(t.updated_poll_id),
	],
)

export type TripEndReason = "trip_change" | "disappeared" | "gap" | "completed" | "killed"

export const tripRunsTable = sqliteTable(
	"trip_runs",
	{
		id: int().primaryKey({ autoIncrement: true }),
		binding_id: int().notNull(),
		vehicle_id: int().notNull(),
		route_ext: text(),
		direction: int(),
		trip_ext: text(),
		/** True when the upstream trip id was missing or "0": keyed by route/direction. */
		keyed_by_route: int({ mode: "boolean" }).notNull().default(false),
		started_at: int().notNull(),
		ended_at: int(),
		end_reason: text().$type<TripEndReason>(),
		first_stop_seq: int(),
		last_stop_seq: int(),
		max_stop_seq: int(),
		samples: int().notNull().default(1),
		scheduled_start_s: int(),
		start_delay_s: int(),
	},
	(t) => [
		index("trip_runs_route_idx").on(t.binding_id, t.route_ext, t.direction, t.started_at),
		index("trip_runs_vehicle_idx").on(t.vehicle_id, t.started_at),
		index("trip_runs_open_idx")
			.on(t.binding_id)
			.where(sql`${t.ended_at} IS NULL`),
	],
)

export type PollOutcome =
	| "ok"
	| "empty"
	| "duplicate_header"
	| "upstream_error"
	| "decode_error"
	| "timeout"
	| "auth_error"
	| "rate_limited"
	| "skipped_killed"
	| "skipped_backoff"

export interface PollDropped {
	staff: number
	test: number
	stale: number
	no_route: number
	out_of_bbox: number
	invalid: number
}

export const pollsTable = sqliteTable(
	"polls",
	{
		id: int().primaryKey({ autoIncrement: true }),
		binding_id: int().notNull(),
		started_at: int().notNull(),
		duration_ms: int().notNull(),
		url_variant: text().$type<"primary" | "fallback">(),
		http_status: int(),
		outcome: text().$type<PollOutcome>().notNull(),
		feed_ts: int(),
		entities: int().notNull().default(0),
		accepted: int().notNull().default(0),
		inserted: int().notNull().default(0),
		dropped: text({ mode: "json" }).$type<PollDropped>(),
		error: text(),
	},
	(t) => [index("polls_binding_idx").on(t.binding_id, t.started_at)],
)

export const providerTokensTable = sqliteTable("provider_tokens", {
	realm: text().primaryKey(),
	/** AES-GCM sealed with KEY_ENCRYPTION_SECRET; never logged. */
	access_token_enc: text().notNull(),
	expires_at: int().notNull(),
	issued_at: int().notNull(),
	refreshed_at: int().notNull(),
	failures: int().notNull().default(0),
})

export const archiveManifestTable = sqliteTable(
	"archive_manifest",
	{
		binding_id: int().notNull(),
		/** UTC date YYYY-MM-DD of feed_ts. */
		date: text().notNull(),
		dataset: text().$type<"positions" | "trip_runs" | "polls">().notNull(),
		rows: int().notNull(),
		bytes: int().notNull(),
		sha256: text().notNull(),
		path: text().notNull(),
		exported_at: int().notNull(),
		uploaded_at: int(),
		verified_at: int(),
	},
	(t) => [primaryKey({ columns: [t.binding_id, t.date, t.dataset] })],
)

export type VehicleRow = typeof vehiclesTable.$inferSelect
export type PositionRow = typeof positionsTable.$inferInsert
export type VehicleStateRow = typeof vehicleStateTable.$inferSelect
export type TripRunRow = typeof tripRunsTable.$inferSelect
export type PollRow = typeof pollsTable.$inferSelect

/** Kentkart accounts this backend registered or was given (KENTKART_AUTO_AUTH). Tracker-owned. */
export type ProviderAccountState =
	"provisioning" | "active" | "refresh_failed" | "login_failed" | "disabled" | "retired"

export const providerAccountsTable = sqliteTable(
	"provider_accounts",
	{
		id: int().primaryKey({ autoIncrement: true }),
		/** Same key as provider_tokens.realm (kentkart:<auth_realm>:<region>). */
		realm: text().notNull(),
		provider: text().notNull(),
		email: text().notNull(),
		/** AES-GCM sealed with KEY_ENCRYPTION_SECRET (purpose provider-account); never logged. */
		password_enc: text(),
		refresh_token_enc: text(),
		state: text().$type<ProviderAccountState>().notNull(),
		/** env: KENTKART_REFRESH_TOKEN; auto: registered by this backend. */
		origin: text().$type<"env" | "auto">().notNull(),
		created_at: int().notNull(),
		registered_at: int(),
		last_login_at: int(),
		last_refresh_at: int(),
		failures: int().notNull().default(0),
		/** Redacted, no tokens or codes. */
		last_error: text(),
		retired_at: int(),
	},
	(t) => [
		index("provider_accounts_realm_idx").on(t.realm, t.state),
		uniqueIndex("provider_accounts_email_unique").on(t.provider, t.email),
	],
)

/**
 * Inbound mail for provider OTPs (MAILBOX_READER=webhook|smtp). Written by whichever process
 * receives the mail, read by the tracker. Rows expire after an hour.
 */
export const inboundEmailsTable = sqliteTable(
	"inbound_emails",
	{
		id: text().primaryKey(),
		received_at: int().notNull(),
		to_addr: text().notNull(),
		from_addr: text().notNull(),
		subject: text().notNull(),
		/** Plain-text body, truncated to 64 KiB. */
		body_text: text().notNull(),
		consumed_at: int(),
		expires_at: int().notNull(),
	},
	(t) => [
		index("inbound_emails_to_idx").on(t.to_addr, t.received_at),
		index("inbound_emails_expires_idx").on(t.expires_at),
	],
)
