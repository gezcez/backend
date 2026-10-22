// archive.repository.ts
// vts.db access for the archive export and the analytics hot path: streaming reads of one
// binding's positions, runs and polls in a time range (rows in the staging column order of
// archive.datasets.ts), independent counts for export verification, and archive_manifest.
// Reads use the raw bun:sqlite handle with cached statements; the manifest goes through drizzle.

import type { Statement } from "bun:sqlite"
import { Injectable } from "@nestjs/common"
import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm"
import { InjectVtsDb, type VtsDatabase } from "@db"
import { archiveManifestTable, type PollDropped } from "@schemas/vts"
import type { Dataset } from "./archive.datasets"

export type ManifestRow = typeof archiveManifestTable.$inferSelect

export interface RangeStats {
	rows: number
	/** min and max of the dataset's partition timestamp (unix seconds). */
	min: number | null
	max: number | null
}

export interface ManifestFilter {
	bindingId?: number
	from?: string
	to?: string
	limit: number
}

const POSITIONS_SQL = `
	SELECT p.vehicle_id, v.external_id AS vehicle_ext, v.plate, p.vehicle_ts, p.feed_ts,
	       p.route_ext, p.direction, p.trip_ext, p.stop_ext, p.stop_seq, p.status,
	       p.lat_e6, p.lon_e6, p.bearing_d10, p.speed_cms, p.quality
	FROM positions p JOIN vehicles v ON v.id = p.vehicle_id
	WHERE p.binding_id = ? AND p.feed_ts >= ? AND p.feed_ts < ?`

const RUNS_COLUMNS = `
	r.id, r.vehicle_id, v.external_id AS vehicle_ext, v.plate, r.route_ext, r.direction,
	r.trip_ext, r.keyed_by_route, r.started_at, r.ended_at, r.end_reason, r.first_stop_seq,
	r.last_stop_seq, r.max_stop_seq, r.samples, r.scheduled_start_s, r.start_delay_s`

const RUNS_SQL = `
	SELECT ${RUNS_COLUMNS}
	FROM trip_runs r JOIN vehicles v ON v.id = r.vehicle_id
	WHERE r.binding_id = ? AND r.ended_at >= ? AND r.ended_at < ?`

const OPEN_RUNS_SQL = `
	SELECT ${RUNS_COLUMNS}
	FROM trip_runs r JOIN vehicles v ON v.id = r.vehicle_id
	WHERE r.binding_id = ? AND r.ended_at IS NULL AND r.started_at >= ? AND r.started_at < ?`

const POLLS_SQL = `
	SELECT id, started_at, duration_ms, url_variant, http_status, outcome, feed_ts, entities,
	       accepted, inserted, dropped, error
	FROM polls WHERE binding_id = ? AND started_at >= ? AND started_at < ?`

type Row = Record<string, unknown>

@Injectable()
export class ArchiveRepository {
	private readonly statements = new Map<string, Statement<Row>>()

	constructor(@InjectVtsDb() private readonly db: VtsDatabase) {}

	/**
	 * A fresh statement for streaming reads: callers may pause between rows (the DuckDB appender
	 * yields to the event loop), so two requests must never share one cursor.
	 */
	private *iterate(text: string, params: (string | number)[]): Generator<Row> {
		const statement = this.db.$client.prepare<Row, (string | number)[]>(text)
		try {
			yield* statement.iterate(...params)
		} finally {
			statement.finalize()
		}
	}

	private stmt(text: string): Statement<Row> {
		let statement = this.statements.get(text)
		if (!statement) {
			statement = this.db.$client.query<Row, (string | number | null)[]>(text)
			this.statements.set(text, statement)
		}
		return statement
	}

	// ---- streaming reads (staging column order) -------------------------------------------------

	*positions(bindingId: number, from: number, to: number, ordered = true): Generator<unknown[]> {
		const text = ordered
			? `${POSITIONS_SQL} ORDER BY p.vehicle_id, p.vehicle_ts`
			: POSITIONS_SQL
		for (const r of this.iterate(text, [bindingId, from, to]))
			yield [
				r.vehicle_id,
				r.vehicle_ext,
				r.plate,
				r.vehicle_ts,
				r.feed_ts,
				r.route_ext,
				r.direction,
				r.trip_ext,
				r.stop_ext,
				r.stop_seq,
				r.status,
				r.lat_e6,
				r.lon_e6,
				r.bearing_d10,
				r.speed_cms,
				r.quality,
			]
	}

	private *runRows(text: string, params: number[]): Generator<unknown[]> {
		for (const r of this.iterate(text, params))
			yield [
				r.id,
				r.vehicle_id,
				r.vehicle_ext,
				r.plate,
				r.route_ext,
				r.direction,
				r.trip_ext,
				Boolean(r.keyed_by_route),
				r.started_at,
				r.ended_at,
				r.end_reason,
				r.first_stop_seq,
				r.last_stop_seq,
				r.max_stop_seq,
				r.samples,
				r.scheduled_start_s,
				r.start_delay_s,
			]
	}

	/** Runs that ended in [from, to). */
	runs(bindingId: number, from: number, to: number): Generator<unknown[]> {
		return this.runRows(RUNS_SQL, [bindingId, from, to])
	}

	/** Open runs (never archived) that started in [from, to). */
	openRuns(bindingId: number, from: number, to: number): Generator<unknown[]> {
		return this.runRows(OPEN_RUNS_SQL, [bindingId, from, to])
	}

	*polls(bindingId: number, from: number, to: number): Generator<unknown[]> {
		for (const r of this.iterate(POLLS_SQL, [bindingId, from, to])) {
			let dropped: Partial<PollDropped> = {}
			if (typeof r.dropped === "string") {
				try {
					dropped = JSON.parse(r.dropped) as Partial<PollDropped>
				} catch {
					dropped = {}
				}
			}
			yield [
				r.id,
				r.started_at,
				r.duration_ms,
				r.url_variant,
				r.http_status,
				r.outcome,
				r.feed_ts,
				r.entities,
				r.accepted,
				r.inserted,
				dropped.staff ?? 0,
				dropped.test ?? 0,
				dropped.stale ?? 0,
				dropped.no_route ?? 0,
				dropped.out_of_bbox ?? 0,
				dropped.invalid ?? 0,
				r.error,
			]
		}
	}

	/** Rows for a dataset partition: positions by feed_ts, runs by ended_at, polls by started_at. */
	rows(dataset: Dataset, bindingId: number, from: number, to: number): Generator<unknown[]> {
		if (dataset === "positions") return this.positions(bindingId, from, to)
		if (dataset === "trip_runs") return this.runs(bindingId, from, to)
		return this.polls(bindingId, from, to)
	}

	/** Independent count and min/max of the partition column, to verify an export. */
	stats(dataset: Dataset, bindingId: number, from: number, to: number): RangeStats {
		const [table, column] =
			dataset === "positions"
				? ["positions", "feed_ts"]
				: dataset === "trip_runs"
					? ["trip_runs", "ended_at"]
					: ["polls", "started_at"]
		const row = this.stmt(
			`SELECT count(*) AS n, min(${column}) AS lo, max(${column}) AS hi FROM ${table}
			 WHERE binding_id = ? AND ${column} >= ? AND ${column} < ?`,
		).get(bindingId, from, to)
		return {
			rows: Number(row?.n ?? 0),
			min: row?.lo === null || row?.lo === undefined ? null : Number(row.lo),
			max: row?.hi === null || row?.hi === undefined ? null : Number(row.hi),
		}
	}

	/** Bindings with polls or closed runs in [from, to) (every tick writes a poll row). */
	bindingsWithData(from: number, to: number): number[] {
		const rows = this.stmt(
			`SELECT DISTINCT binding_id FROM polls WHERE started_at >= ? AND started_at < ?
			 UNION SELECT DISTINCT binding_id FROM trip_runs WHERE ended_at >= ? AND ended_at < ?`,
		).all(from, to, from, to)
		return rows.map((r) => Number(r.binding_id)).sort((a, b) => a - b)
	}

	/** Oldest poll start of a binding (unix seconds), the start of its hot window. */
	oldestPollTs(bindingId: number): number | null {
		const row = this.stmt(`SELECT min(started_at) AS lo FROM polls WHERE binding_id = ?`).get(
			bindingId,
		)
		return row?.lo === null || row?.lo === undefined ? null : Number(row.lo)
	}

	/**
	 * Id of a vehicle in vts.db, created or widened to [firstSeen, lastSeen] (history imports
	 * share vehicle ids with live data).
	 */
	ensureVehicle(
		bindingId: number,
		externalId: string,
		plate: string | null,
		firstSeen: number,
		lastSeen: number,
	): number {
		const row = this.stmt(
			`INSERT INTO vehicles (binding_id, external_id, plate, first_seen_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (binding_id, external_id) DO UPDATE SET
			   plate = coalesce(vehicles.plate, excluded.plate),
			   first_seen_at = min(vehicles.first_seen_at, excluded.first_seen_at),
			   last_seen_at = max(vehicles.last_seen_at, excluded.last_seen_at)
			 RETURNING id`,
		).get(bindingId, externalId, plate, firstSeen, lastSeen)
		return Number(row!.id)
	}

	// ---- archive_manifest ------------------------------------------------------------------------

	upsertManifest(
		row: Omit<ManifestRow, "uploaded_at" | "verified_at"> & {
			verified_at: number | null
		},
	): void {
		this.db
			.insert(archiveManifestTable)
			.values({ ...row, uploaded_at: null })
			.onConflictDoUpdate({
				target: [
					archiveManifestTable.binding_id,
					archiveManifestTable.date,
					archiveManifestTable.dataset,
				],
				set: {
					rows: row.rows,
					bytes: row.bytes,
					sha256: row.sha256,
					path: row.path,
					exported_at: row.exported_at,
					verified_at: row.verified_at,
					uploaded_at: null,
				},
			})
			.run()
	}

	markUploaded(bindingId: number, date: string, dataset: Dataset, at: number): void {
		this.db
			.update(archiveManifestTable)
			.set({ uploaded_at: at })
			.where(
				and(
					eq(archiveManifestTable.binding_id, bindingId),
					eq(archiveManifestTable.date, date),
					eq(archiveManifestTable.dataset, dataset),
				),
			)
			.run()
	}

	manifestFor(bindingId: number, date: string): ManifestRow[] {
		return this.db
			.select()
			.from(archiveManifestTable)
			.where(
				and(
					eq(archiveManifestTable.binding_id, bindingId),
					eq(archiveManifestTable.date, date),
				),
			)
			.all()
	}

	listManifest(filter: ManifestFilter): ManifestRow[] {
		const conditions = [
			filter.bindingId === undefined
				? undefined
				: eq(archiveManifestTable.binding_id, filter.bindingId),
			filter.from === undefined ? undefined : gte(archiveManifestTable.date, filter.from),
			filter.to === undefined ? undefined : lte(archiveManifestTable.date, filter.to),
		].filter((c) => c !== undefined)
		return this.db
			.select()
			.from(archiveManifestTable)
			.where(conditions.length ? and(...conditions) : undefined)
			.orderBy(
				desc(archiveManifestTable.date),
				archiveManifestTable.binding_id,
				archiveManifestTable.dataset,
			)
			.limit(filter.limit)
			.all()
	}

	/** Verified partitions still waiting for (or failed) upload. */
	pendingUploads(): ManifestRow[] {
		return this.db
			.select()
			.from(archiveManifestTable)
			.where(
				and(
					isNotNull(archiveManifestTable.verified_at),
					isNull(archiveManifestTable.uploaded_at),
				),
			)
			.all()
	}

	/** (binding, date) pairs that are not fully verified: failed or partial exports. */
	unverifiedDays(): { binding_id: number; date: string }[] {
		return this.db
			.selectDistinct({
				binding_id: archiveManifestTable.binding_id,
				date: archiveManifestTable.date,
			})
			.from(archiveManifestTable)
			.where(isNull(archiveManifestTable.verified_at))
			.all()
	}

	/** Every verified (binding, date) whose three datasets are verified. */
	verifiedDays(): { binding_id: number; date: string }[] {
		return this.db
			.select({
				binding_id: archiveManifestTable.binding_id,
				date: archiveManifestTable.date,
			})
			.from(archiveManifestTable)
			.where(isNotNull(archiveManifestTable.verified_at))
			.groupBy(archiveManifestTable.binding_id, archiveManifestTable.date)
			.having(sql`count(*) = 3`)
			.all()
	}

	/** Days whose three datasets are uploaded (safe to drop from local disk). */
	uploadedDays(before: string): { binding_id: number; date: string }[] {
		return this.db
			.select({
				binding_id: archiveManifestTable.binding_id,
				date: archiveManifestTable.date,
			})
			.from(archiveManifestTable)
			.where(
				and(
					isNotNull(archiveManifestTable.uploaded_at),
					sql`${archiveManifestTable.date} < ${before}`,
				),
			)
			.groupBy(archiveManifestTable.binding_id, archiveManifestTable.date)
			.having(sql`count(*) = 3`)
			.all()
	}
}
