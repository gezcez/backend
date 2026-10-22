// archive.datasets.ts
// The three archived datasets (plan 5.4): the DuckDB staging table that bun:sqlite rows are
// appended to, and the projection that turns staged rows into the Parquet columns. The archive
// export and the analytics hot path use the same projection, so a view over Parquet files and a
// view over hot vts.db rows have identical columns.

import path from "node:path"

export type Dataset = "positions" | "trip_runs" | "polls"
export const DATASETS: readonly Dataset[] = ["positions", "trip_runs", "polls"]

interface DatasetSpec {
	/** Staging columns in the order the repository yields them. */
	staging: readonly (readonly [string, string])[]
	/** SELECT list from the staging table to the Parquet columns. */
	projection: string
	/** Parquet sort order. */
	orderBy: string
	/** Timestamp column (seconds in staging) that decides the UTC partition date. */
	dateColumn: string
}

const ts = (column: string) => `make_timestamp(${column} * 1000000) AS ${column}`

export const DATASET_SPECS: Record<Dataset, DatasetSpec> = {
	positions: {
		staging: [
			["vehicle_id", "INTEGER"],
			["vehicle_ext", "VARCHAR"],
			["plate", "VARCHAR"],
			["vehicle_ts", "BIGINT"],
			["feed_ts", "BIGINT"],
			["route_ext", "VARCHAR"],
			["direction", "INTEGER"],
			["trip_ext", "VARCHAR"],
			["stop_ext", "VARCHAR"],
			["stop_seq", "INTEGER"],
			["status", "INTEGER"],
			["lat_e6", "INTEGER"],
			["lon_e6", "INTEGER"],
			["bearing_d10", "INTEGER"],
			["speed_cms", "INTEGER"],
			["quality", "INTEGER"],
		],
		projection: [
			"vehicle_id::INTEGER AS vehicle_id",
			"vehicle_ext",
			"plate",
			ts("vehicle_ts"),
			ts("feed_ts"),
			"route_ext",
			"direction::TINYINT AS direction",
			"trip_ext",
			"stop_ext",
			"stop_seq::SMALLINT AS stop_seq",
			"status::TINYINT AS status",
			"lat_e6::INTEGER AS lat_e6",
			"lon_e6::INTEGER AS lon_e6",
			"bearing_d10::SMALLINT AS bearing_d10",
			"speed_cms::SMALLINT AS speed_cms",
			"quality::UTINYINT AS quality",
		].join(", "),
		orderBy: "vehicle_id, vehicle_ts",
		dateColumn: "feed_ts",
	},
	trip_runs: {
		staging: [
			["id", "INTEGER"],
			["vehicle_id", "INTEGER"],
			["vehicle_ext", "VARCHAR"],
			["plate", "VARCHAR"],
			["route_ext", "VARCHAR"],
			["direction", "INTEGER"],
			["trip_ext", "VARCHAR"],
			["keyed_by_route", "BOOLEAN"],
			["started_at", "BIGINT"],
			["ended_at", "BIGINT"],
			["end_reason", "VARCHAR"],
			["first_stop_seq", "INTEGER"],
			["last_stop_seq", "INTEGER"],
			["max_stop_seq", "INTEGER"],
			["samples", "INTEGER"],
			["scheduled_start_s", "INTEGER"],
			["start_delay_s", "INTEGER"],
		],
		projection: [
			"id::INTEGER AS id",
			"vehicle_id::INTEGER AS vehicle_id",
			"vehicle_ext",
			"plate",
			"route_ext",
			"direction::TINYINT AS direction",
			"trip_ext",
			"keyed_by_route",
			ts("started_at"),
			ts("ended_at"),
			"end_reason",
			"first_stop_seq::SMALLINT AS first_stop_seq",
			"last_stop_seq::SMALLINT AS last_stop_seq",
			"max_stop_seq::SMALLINT AS max_stop_seq",
			"samples::INTEGER AS samples",
			"scheduled_start_s::INTEGER AS scheduled_start_s",
			"start_delay_s::INTEGER AS start_delay_s",
		].join(", "),
		orderBy: "started_at, id",
		dateColumn: "ended_at",
	},
	polls: {
		staging: [
			["id", "INTEGER"],
			["started_at", "BIGINT"],
			["duration_ms", "INTEGER"],
			["url_variant", "VARCHAR"],
			["http_status", "INTEGER"],
			["outcome", "VARCHAR"],
			["feed_ts", "BIGINT"],
			["entities", "INTEGER"],
			["accepted", "INTEGER"],
			["inserted", "INTEGER"],
			["dropped_staff", "INTEGER"],
			["dropped_test", "INTEGER"],
			["dropped_stale", "INTEGER"],
			["dropped_no_route", "INTEGER"],
			["dropped_out_of_bbox", "INTEGER"],
			["dropped_invalid", "INTEGER"],
			["error", "VARCHAR"],
		],
		projection: [
			"id::INTEGER AS id",
			ts("started_at"),
			"duration_ms::INTEGER AS duration_ms",
			"url_variant",
			"http_status::SMALLINT AS http_status",
			"outcome",
			ts("feed_ts"),
			"entities::INTEGER AS entities",
			"accepted::INTEGER AS accepted",
			"inserted::INTEGER AS inserted",
			"dropped_staff::INTEGER AS dropped_staff",
			"dropped_test::INTEGER AS dropped_test",
			"dropped_stale::INTEGER AS dropped_stale",
			"dropped_no_route::INTEGER AS dropped_no_route",
			"dropped_out_of_bbox::INTEGER AS dropped_out_of_bbox",
			"dropped_invalid::INTEGER AS dropped_invalid",
			"error",
		].join(", "),
		orderBy: "started_at, id",
		dateColumn: "started_at",
	},
}

/** CREATE TEMP TABLE statement for a dataset's staging table. */
export function stagingDdl(dataset: Dataset, table: string): string {
	const columns = DATASET_SPECS[dataset].staging.map(([name, type]) => `${name} ${type}`)
	return `CREATE OR REPLACE TEMP TABLE ${table} (${columns.join(", ")})`
}

/** YYYY-MM-DD of a unix-seconds instant in UTC. */
export function utcDate(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

/** Unix seconds of 00:00 UTC on a YYYY-MM-DD date. */
export function utcDayStart(date: string): number {
	return Date.parse(`${date}T00:00:00Z`) / 1000
}

/** Relative partition key, shared by the local archive and the R2 bucket. */
export function partitionKey(bindingId: number, date: string, dataset: Dataset): string {
	return `region=${bindingId}/date=${date}/${dataset}.parquet`
}

export function partitionFile(
	archiveDir: string,
	bindingId: number,
	date: string,
	dataset: Dataset,
): string {
	return path.join(archiveDir, partitionKey(bindingId, date, dataset))
}

/** ISO week label YYYY-Www of a YYYY-MM-DD date (segment time rollups). */
export function isoWeek(date: string): string {
	const d = new Date(`${date}T12:00:00Z`)
	const day = (d.getUTCDay() + 6) % 7
	d.setUTCDate(d.getUTCDate() - day + 3)
	const year = d.getUTCFullYear()
	const firstThursday = new Date(Date.UTC(year, 0, 4))
	const week =
		1 +
		Math.round(
			((d.getTime() - firstThursday.getTime()) / 86400000 -
				3 +
				((firstThursday.getUTCDay() + 6) % 7)) /
				7,
		)
	return `${year}-W${String(week).padStart(2, "0")}`
}

/** Monday (YYYY-MM-DD) of the ISO week containing `date`. */
export function isoWeekStart(date: string): string {
	const d = new Date(`${date}T12:00:00Z`)
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
	return d.toISOString().slice(0, 10)
}
