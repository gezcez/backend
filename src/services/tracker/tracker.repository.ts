// tracker.repository.ts
// All vts.db access. The tracker is the only writer (plan 3.1); the API process uses the read
// methods (live snapshot at boot, MODE=api change feed, vehicle detail, dashboard polls).
// The hot path uses cached prepared statements on the raw bun:sqlite handle.

import type { Statement } from "bun:sqlite"
import { Injectable } from "@nestjs/common"
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm"
import { InjectVtsDb, type VtsDatabase } from "@db"
import {
	archiveManifestTable,
	pollsTable,
	tripRunsTable,
	vehicleStateTable,
	vehiclesTable,
	type PollDropped,
	type PollOutcome,
	type PollRow,
	type TripRunRow,
	type VehicleRow,
	type VehicleStateRow,
} from "@schemas/vts"
import type { Sample } from "./tracker.pipeline"
import type { LiveVehicle } from "./tracker.types"
import type { OpenRun, RunEvent, TrackedVehicle } from "./trip-detector"

export interface PollRecord {
	binding_id: number
	started_at: number
	duration_ms: number
	url_variant: "primary" | "fallback" | null
	http_status: number | null
	outcome: PollOutcome
	feed_ts: number | null
	entities: number
	accepted: number
	dropped: PollDropped | null
	error: string | null
}

export interface DetectResult {
	events: RunEvent[]
	/** Vehicles whose vehicle_state row must be rewritten. */
	touched: TrackedVehicle[]
}

const RETENTION_BATCH = 50_000

export function stateToLive(row: VehicleStateRow): LiveVehicle {
	return {
		vehicle_id: row.vehicle_id,
		binding_id: row.binding_id,
		external_id: row.external_id,
		plate: row.plate,
		label: row.label,
		lat_e6: row.lat_e6,
		lon_e6: row.lon_e6,
		bearing_d10: row.bearing_d10,
		speed_cms: row.speed_cms,
		route_ext: row.route_ext,
		direction: row.direction,
		trip_ext: row.trip_ext,
		stop_ext: row.stop_ext,
		stop_seq: row.stop_seq,
		status: row.status,
		vehicle_ts: row.vehicle_ts,
		feed_ts: row.feed_ts,
		quality: row.quality,
	}
}

export function trackedToLive(v: TrackedVehicle): LiveVehicle {
	const s = v.sample
	return {
		vehicle_id: v.vehicleId,
		binding_id: v.bindingId,
		external_id: v.externalId,
		plate: s.plate,
		label: s.label,
		lat_e6: s.latE6,
		lon_e6: s.lonE6,
		bearing_d10: s.bearingD10,
		speed_cms: s.speedCms,
		route_ext: s.routeExt,
		direction: s.direction,
		trip_ext: s.tripExt,
		stop_ext: s.stopExt,
		stop_seq: s.stopSeq,
		status: s.status,
		vehicle_ts: s.vehicleTs,
		feed_ts: v.feedTs,
		quality: s.quality,
	}
}

function rowToTracked(row: VehicleStateRow): TrackedVehicle {
	const run: OpenRun | null =
		row.open_run_id !== null && row.run_route_ext !== null && row.run_started_at !== null
			? {
					id: row.open_run_id,
					tripExt: row.run_trip_ext,
					routeExt: row.run_route_ext,
					direction: row.run_direction,
					keyedByRoute: !row.run_trip_ext || row.run_trip_ext === "0",
					startedAt: row.run_started_at,
					lastTs: row.run_last_ts ?? row.run_started_at,
					firstStopSeq: row.run_first_stop_seq,
					lastStopSeq: row.run_last_stop_seq,
					maxStopSeq: row.max_stop_seq,
					samples: row.run_samples ?? 1,
					scheduledStartS: null,
					startDelayS: null,
				}
			: null
	return {
		vehicleId: row.vehicle_id,
		bindingId: row.binding_id,
		externalId: row.external_id,
		sample: {
			externalId: row.external_id,
			plate: row.plate,
			label: row.label,
			routeExt: row.route_ext,
			direction: row.direction,
			tripExt: row.trip_ext,
			stopExt: row.stop_ext,
			stopSeq: row.stop_seq,
			status: row.status,
			latE6: row.lat_e6,
			lonE6: row.lon_e6,
			bearingD10: row.bearing_d10,
			speedCms: row.speed_cms,
			vehicleTs: row.vehicle_ts,
			quality: row.quality,
			kindFlags: 0,
		},
		feedTs: row.feed_ts,
		live: row.live === 1,
		run,
		lastSeenFeedTs: row.last_seen_feed_ts,
		missingPolls: row.missing_polls,
	}
}

@Injectable()
export class TrackerRepository {
	private statements: Record<string, Statement> | undefined

	constructor(@InjectVtsDb() private readonly db: VtsDatabase) {}

	private get stmt(): Record<string, Statement> {
		if (this.statements) return this.statements
		const c = this.db.$client
		this.statements = {
			vehicle: c.prepare(
				`INSERT INTO vehicles (binding_id, external_id, plate, label, kind_flags, first_seen_at, last_seen_at)
				 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
				 ON CONFLICT (binding_id, external_id) DO UPDATE SET
				   plate = coalesce(excluded.plate, plate), label = coalesce(excluded.label, label),
				   last_seen_at = max(last_seen_at, excluded.last_seen_at)
				 RETURNING id`,
			),
			position: c.prepare(
				`INSERT OR IGNORE INTO positions (vehicle_id, vehicle_ts, feed_ts, binding_id, route_ext,
				   direction, trip_ext, stop_ext, stop_seq, status, lat_e6, lon_e6, bearing_d10, speed_cms, quality)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
			),
			openRun: c.prepare(
				`INSERT INTO trip_runs (binding_id, vehicle_id, route_ext, direction, trip_ext, keyed_by_route,
				   started_at, first_stop_seq, last_stop_seq, max_stop_seq, samples, scheduled_start_s, start_delay_s)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING id`,
			),
			extendRun: c.prepare(
				`UPDATE trip_runs SET last_stop_seq = ?2, max_stop_seq = ?3, samples = ?4 WHERE id = ?1`,
			),
			closeRun: c.prepare(
				`UPDATE trip_runs SET ended_at = ?2, end_reason = ?3, last_stop_seq = ?4, max_stop_seq = ?5,
				   samples = ?6 WHERE id = ?1 AND ended_at IS NULL`,
			),
			state: c.prepare(
				`INSERT INTO vehicle_state (vehicle_id, binding_id, external_id, plate, label, vehicle_ts, feed_ts,
				   lat_e6, lon_e6, bearing_d10, speed_cms, route_ext, direction, trip_ext, stop_ext, stop_seq,
				   status, quality, live, open_run_id, run_trip_ext, run_route_ext, run_direction, run_started_at,
				   run_last_ts, run_first_stop_seq, run_last_stop_seq, run_samples, last_seen_feed_ts,
				   missing_polls, max_stop_seq, updated_poll_id)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
				   ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32)
				 ON CONFLICT (vehicle_id) DO UPDATE SET plate = excluded.plate, label = excluded.label,
				   vehicle_ts = excluded.vehicle_ts, feed_ts = excluded.feed_ts, lat_e6 = excluded.lat_e6,
				   lon_e6 = excluded.lon_e6, bearing_d10 = excluded.bearing_d10, speed_cms = excluded.speed_cms,
				   route_ext = excluded.route_ext, direction = excluded.direction, trip_ext = excluded.trip_ext,
				   stop_ext = excluded.stop_ext, stop_seq = excluded.stop_seq, status = excluded.status,
				   quality = excluded.quality, live = excluded.live, open_run_id = excluded.open_run_id,
				   run_trip_ext = excluded.run_trip_ext, run_route_ext = excluded.run_route_ext,
				   run_direction = excluded.run_direction, run_started_at = excluded.run_started_at,
				   run_last_ts = excluded.run_last_ts, run_first_stop_seq = excluded.run_first_stop_seq,
				   run_last_stop_seq = excluded.run_last_stop_seq, run_samples = excluded.run_samples,
				   last_seen_feed_ts = excluded.last_seen_feed_ts, missing_polls = excluded.missing_polls,
				   max_stop_seq = excluded.max_stop_seq, updated_poll_id = excluded.updated_poll_id`,
			),
		}
		return this.statements
	}

	// ---- tracker (writer) side ----------------------------------------------------------------

	loadVehicles(bindingId: number): TrackedVehicle[] {
		return this.db
			.select()
			.from(vehicleStateTable)
			.where(eq(vehicleStateTable.binding_id, bindingId))
			.all()
			.map(rowToTracked)
	}

	recordPoll(record: PollRecord): number {
		return this.db
			.insert(pollsTable)
			.values({ ...record, inserted: 0 })
			.returning({ id: pollsTable.id })
			.get().id
	}

	private applyEvent(event: RunEvent): void {
		const { run, vehicle } = event
		if (event.kind === "open") {
			const row = this.stmt.openRun!.get(
				vehicle.bindingId,
				vehicle.vehicleId,
				run.routeExt,
				run.direction,
				run.tripExt,
				run.keyedByRoute ? 1 : 0,
				run.startedAt,
				run.firstStopSeq,
				run.lastStopSeq,
				run.maxStopSeq,
				run.samples,
				run.scheduledStartS,
				run.startDelayS,
			) as { id: number }
			run.id = row.id
		} else if (event.kind === "extend") {
			if (run.id !== null)
				this.stmt.extendRun!.run(run.id, run.lastStopSeq, run.maxStopSeq, run.samples)
		} else if (run.id !== null) {
			this.stmt.closeRun!.run(
				run.id,
				event.endedAt,
				event.reason,
				run.lastStopSeq,
				run.maxStopSeq,
				run.samples,
			)
		}
	}

	private writeState(v: TrackedVehicle, pollId: number): void {
		const s = v.sample
		const r = v.run
		this.stmt.state!.run(
			v.vehicleId,
			v.bindingId,
			v.externalId,
			s.plate,
			s.label,
			s.vehicleTs,
			v.feedTs,
			s.latE6,
			s.lonE6,
			s.bearingD10,
			s.speedCms,
			s.routeExt,
			s.direction,
			s.tripExt,
			s.stopExt,
			s.stopSeq,
			s.status,
			s.quality,
			v.live ? 1 : 0,
			r?.id ?? null,
			r?.tripExt ?? null,
			r?.routeExt ?? null,
			r?.direction ?? null,
			r?.startedAt ?? null,
			r?.lastTs ?? null,
			r?.firstStopSeq ?? null,
			r?.lastStopSeq ?? null,
			r?.samples ?? null,
			v.lastSeenFeedTs,
			v.missingPolls,
			r?.maxStopSeq ?? null,
			pollId,
		)
	}

	/**
	 * One transaction per accepted poll (plan 8.1): polls row, vehicles, INSERT OR IGNORE
	 * positions, trip_runs events and vehicle_state. `detect` runs inside the transaction once
	 * vehicle ids are known, so detection and its writes commit or roll back together.
	 */
	writePoll(
		record: PollRecord,
		samples: Sample[],
		detect: (vehicleIds: Map<string, number>) => DetectResult,
	): { pollId: number; inserted: number; events: RunEvent[]; touched: TrackedVehicle[] } {
		const client = this.db.$client
		return client.transaction(() => {
			const pollId = this.recordPoll(record)
			const ids = new Map<string, number>()
			for (const s of samples) {
				const row = this.stmt.vehicle!.get(
					record.binding_id,
					s.externalId,
					s.plate,
					s.label,
					s.vehicleTs,
				) as { id: number }
				ids.set(s.externalId, row.id)
			}
			let inserted = 0
			for (const s of samples) {
				inserted += this.stmt.position!.run(
					ids.get(s.externalId)!,
					s.vehicleTs,
					record.feed_ts,
					record.binding_id,
					s.routeExt,
					s.direction,
					s.tripExt,
					s.stopExt,
					s.stopSeq,
					s.status,
					s.latE6,
					s.lonE6,
					s.bearingD10,
					s.speedCms,
					s.quality,
				).changes
			}
			const { events, touched } = detect(ids)
			for (const event of events) this.applyEvent(event)
			for (const v of touched) this.writeState(v, pollId)
			client.query("UPDATE polls SET inserted = ?2 WHERE id = ?1").run(pollId, inserted)
			return { pollId, inserted, events, touched }
		})()
	}

	/** Closes runs and clears the live flag outside a poll (kill switch, restart gap). */
	writeEvents(
		bindingId: number,
		events: RunEvent[],
		touched: TrackedVehicle[],
		outcome: PollOutcome,
		error: string | null = null,
	): number {
		const client = this.db.$client
		return client.transaction(() => {
			const pollId = this.recordPoll({
				binding_id: bindingId,
				started_at: Math.floor(Date.now() / 1000),
				duration_ms: 0,
				url_variant: null,
				http_status: null,
				outcome,
				feed_ts: null,
				entities: 0,
				accepted: 0,
				dropped: null,
				error: error?.slice(0, 500) ?? null,
			})
			for (const event of events) this.applyEvent(event)
			for (const v of touched) this.writeState(v, pollId)
			return pollId
		})()
	}

	/** Feed timestamp of the last accepted poll (header dedup across restarts). */
	lastAcceptedFeedTs(bindingId: number): number | null {
		return (
			this.db
				.select({ feed_ts: pollsTable.feed_ts })
				.from(pollsTable)
				.where(and(eq(pollsTable.binding_id, bindingId), eq(pollsTable.outcome, "ok")))
				.orderBy(desc(pollsTable.id))
				.limit(1)
				.get()?.feed_ts ?? null
		)
	}

	// ---- readers (API process) ----------------------------------------------------------------

	liveVehicles(bindingIds?: number[]): VehicleStateRow[] {
		const where = bindingIds
			? and(eq(vehicleStateTable.live, 1), inArray(vehicleStateTable.binding_id, bindingIds))
			: eq(vehicleStateTable.live, 1)
		return this.db.select().from(vehicleStateTable).where(where).all()
	}

	maxPollId(): number {
		return (
			this.db
				.select({ id: sql<number | null>`max(${pollsTable.id})` })
				.from(pollsTable)
				.get()?.id ?? 0
		)
	}

	/** vehicle_state rows written after `pollId` (MODE=api change feed, plan 3.1). */
	changedSince(pollId: number): VehicleStateRow[] {
		return this.db
			.select()
			.from(vehicleStateTable)
			.where(sql`${vehicleStateTable.updated_poll_id} > ${pollId}`)
			.all()
	}

	pollsAfter(pollId: number): PollRow[] {
		return this.db
			.select()
			.from(pollsTable)
			.where(sql`${pollsTable.id} > ${pollId}`)
			.orderBy(pollsTable.id)
			.all()
	}

	vehicle(bindingId: number, externalId: string): VehicleRow | undefined {
		return this.db
			.select()
			.from(vehiclesTable)
			.where(
				and(
					eq(vehiclesTable.binding_id, bindingId),
					eq(vehiclesTable.external_id, externalId),
				),
			)
			.get()
	}

	vehicleState(vehicleId: number): VehicleStateRow | undefined {
		return this.db
			.select()
			.from(vehicleStateTable)
			.where(eq(vehicleStateTable.vehicle_id, vehicleId))
			.get()
	}

	runsOfVehicle(vehicleId: number, since: number, limit = 50): TripRunRow[] {
		return this.db
			.select()
			.from(tripRunsTable)
			.where(
				and(eq(tripRunsTable.vehicle_id, vehicleId), gte(tripRunsTable.started_at, since)),
			)
			.orderBy(desc(tripRunsTable.started_at))
			.limit(limit)
			.all()
	}

	runsOfRoute(
		bindingId: number,
		routeExt: string,
		direction: number | null,
		from: number,
		to: number,
	): TripRunRow[] {
		const conditions = [
			eq(tripRunsTable.binding_id, bindingId),
			eq(tripRunsTable.route_ext, routeExt),
			gte(tripRunsTable.started_at, from),
			lt(tripRunsTable.started_at, to),
		]
		if (direction !== null) conditions.push(eq(tripRunsTable.direction, direction))
		return this.db
			.select()
			.from(tripRunsTable)
			.where(and(...conditions))
			.orderBy(tripRunsTable.started_at)
			.all()
	}

	openRuns(bindingId: number): TripRunRow[] {
		return this.db
			.select()
			.from(tripRunsTable)
			.where(and(eq(tripRunsTable.binding_id, bindingId), isNull(tripRunsTable.ended_at)))
			.all()
	}

	polls(bindingId: number, limit: number, offset: number): PollRow[] {
		return this.db
			.select()
			.from(pollsTable)
			.where(eq(pollsTable.binding_id, bindingId))
			.orderBy(desc(pollsTable.id))
			.limit(limit)
			.offset(offset)
			.all()
	}

	pollOutcomes(bindingId: number, since: number): { outcome: PollOutcome; n: number }[] {
		return this.db
			.select({ outcome: pollsTable.outcome, n: sql<number>`count(*)` })
			.from(pollsTable)
			.where(and(eq(pollsTable.binding_id, bindingId), gte(pollsTable.started_at, since)))
			.groupBy(pollsTable.outcome)
			.all()
	}

	positionCount(bindingId: number): number {
		return (
			this.db.$client
				.query<{ n: number }, [number]>(
					"SELECT count(*) AS n FROM positions WHERE binding_id = ?",
				)
				.get(bindingId)?.n ?? 0
		)
	}

	// ---- retention (plan 8.7) -------------------------------------------------------------------

	/** UTC dates whose positions archive is uploaded and verified. */
	archivedDates(bindingId: number): Set<string> {
		return new Set(
			this.db
				.select({ date: archiveManifestTable.date })
				.from(archiveManifestTable)
				.where(
					and(
						eq(archiveManifestTable.binding_id, bindingId),
						eq(archiveManifestTable.dataset, "positions"),
						sql`${archiveManifestTable.uploaded_at} IS NOT NULL`,
						sql`${archiveManifestTable.verified_at} IS NOT NULL`,
					),
				)
				.all()
				.map((r) => r.date),
		)
	}

	/** Oldest feed_ts with positions for a binding. */
	oldestPositionTs(bindingId: number): number | null {
		return (
			this.db.$client
				.query<{ ts: number | null }, [number]>(
					"SELECT min(feed_ts) AS ts FROM positions WHERE binding_id = ?",
				)
				.get(bindingId)?.ts ?? null
		)
	}

	/** Deletes positions with feed_ts in [from, to) in batches; returns rows deleted. */
	deletePositions(bindingId: number, from: number, to: number): number {
		const statement = this.db.$client.query(
			`DELETE FROM positions WHERE (vehicle_id, vehicle_ts) IN (
			   SELECT vehicle_id, vehicle_ts FROM positions
			   WHERE binding_id = ?1 AND feed_ts >= ?2 AND feed_ts < ?3 LIMIT ${RETENTION_BATCH})`,
		)
		let total = 0
		for (;;) {
			const { changes } = statement.run(bindingId, from, to)
			total += changes
			if (changes < RETENTION_BATCH) return total
		}
	}

	deleteOldPolls(before: number): number {
		return this.db.$client.query("DELETE FROM polls WHERE started_at < ?").run(before).changes
	}

	deleteOldRuns(before: number): number {
		return this.db.$client
			.query("DELETE FROM trip_runs WHERE ended_at IS NOT NULL AND ended_at < ?")
			.run(before).changes
	}

	incrementalVacuum(): void {
		this.db.$client.exec("PRAGMA incremental_vacuum")
	}
}
