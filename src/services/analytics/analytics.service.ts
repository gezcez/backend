// analytics.service.ts
// Runs the metrics of analytics.queries.ts for a network and a window (plan 6.9). Per request,
// on its own DuckDB connection, it builds temp views that union the archived Parquet partitions
// of the window with hot vts.db rows for the dates that are not archived yet (today, and
// yesterday before the 03:30 export), so every window answers from one SQL text. fleet.hourly at
// 1 h reads the nightly rollup (data/agg/fleet_hourly) when the whole window is rolled up.
// Results are cached (LRU, 10 min while the window touches today, 24 h for closed windows).

import { Injectable } from "@nestjs/common"
import type { DuckDBConnection } from "@duckdb/node-api"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ulid } from "ulid"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { addDays, localTime, zonedInstant } from "@common/utils"
import {
	DATASET_SPECS,
	partitionFile,
	stagingDdl,
	utcDate,
	utcDayStart,
	type Dataset,
} from "@services/archive/archive.datasets"
import { ArchiveRepository } from "@services/archive/archive.repository"
import { ANALYTICS_MAX_DAYS, type AnalyticsQuery, type MetricResult } from "./analytics.dto"
import { AnalyticsRepository } from "./analytics.repository"
import { filters, METRICS, type MetricDef, type MetricParams } from "./analytics.queries"
import { aggFile } from "./aggregates.paths"
import { DuckDBService, sqlString } from "./duckdb.service"

export interface MetricScope {
	bindingIds: number[]
	timezone: string
}

type Source = MetricResult["meta"]["source"]

interface Prepared {
	params: MetricParams
	start: number
	end: number
	days: number
	closed: boolean
}

interface CacheEntry {
	expires: number
	value: MetricResult
}

const CACHE_MAX = 200
const RECENT_TTL_MS = 10 * 60 * 1000
const CLOSED_TTL_MS = 24 * 3600 * 1000
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/

const ts = (seconds: number) => `make_timestamp(${seconds}::BIGINT * 1000000)`

function* chain(parts: Iterable<unknown[]>[]): Generator<unknown[]> {
	for (const part of parts) yield* part
}

@Injectable()
export class AnalyticsService {
	private readonly cache = new Map<string, CacheEntry>()

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly duckdb: DuckDBService,
		private readonly vts: ArchiveRepository,
		private readonly repository: AnalyticsRepository,
	) {}

	static definition(metric: string): MetricDef {
		const def = (METRICS as Record<string, MetricDef | undefined>)[metric]
		if (!def) throw new GezcezError("NOT_FOUND", `Unknown metric: ${metric}`)
		return def
	}

	/** Normalises and checks the window and the metric's own parameters. */
	prepare(def: MetricDef, query: AnalyticsQuery, scope: MetricScope, now = Date.now()): Prepared {
		if (!TIMEZONE.test(scope.timezone))
			throw new GezcezError("INTERNAL", "Invalid network time zone")
		const today = localTime(Math.floor(now / 1000), scope.timezone).date
		const to = query.date ?? query.to ?? today
		const from = query.date ?? query.from ?? addDays(to, -6)
		const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1
		const fail = (message: string) =>
			new GezcezError("VALIDATION_FAILED", message, { fields: { from: message } })
		if (Number.isNaN(days) || days < 1) throw fail("`from` must not be after `to`")
		if (days > ANALYTICS_MAX_DAYS) throw fail(`At most ${ANALYTICS_MAX_DAYS} days per request`)
		if (query.hour_from > query.hour_to) throw fail("`hour_from` must not be after `hour_to`")
		const params: MetricParams = {
			from,
			to,
			routes: query.route_id,
			direction: query.direction,
			day_type: query.day_type,
			hour_from: query.hour_from,
			hour_to: query.hour_to,
			granularity: query.granularity,
			res: query.res,
			hour: query.hour,
			min_samples: query.min_samples,
			min_stops: query.min_stops,
			stop_id: query.stop_id,
			limit: query.limit,
		}
		const problem = def.validate?.(params)
		if (problem) throw new GezcezError("VALIDATION_FAILED", problem)
		return {
			params,
			start: zonedInstant(from, 0, scope.timezone),
			end: zonedInstant(addDays(to, 1), 0, scope.timezone),
			days,
			closed: to < today,
		}
	}

	async run(metric: string, query: AnalyticsQuery, scope: MetricScope): Promise<MetricResult> {
		const def = AnalyticsService.definition(metric)
		const prepared = this.prepare(def, query, scope)
		const key = JSON.stringify([def.key, scope, prepared.params])
		const cached = this.cache.get(key)
		if (cached && cached.expires > Date.now()) {
			this.cache.delete(key)
			this.cache.set(key, cached)
			return cached.value
		}
		const value = await this.duckdb.withConnection(async (connection) => {
			const { sql, source } = await this.build(connection, def, prepared, scope)
			const result = await DuckDBService.query(connection, sql)
			return {
				columns: result.columns,
				rows: result.rows,
				meta: {
					metric: def.key,
					n: result.rows.length,
					generated_at: new Date().toISOString(),
					source,
					timezone: scope.timezone,
					from: prepared.params.from,
					to: prepared.params.to,
					binding_ids: scope.bindingIds,
				},
			}
		})
		this.cache.set(key, {
			expires: Date.now() + (prepared.closed ? CLOSED_TTL_MS : RECENT_TTL_MS),
			value,
		})
		while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
		return value
	}

	/** Writes the metric to a temp CSV or Parquet file with DuckDB COPY; the caller deletes it. */
	async export(
		metric: string,
		query: AnalyticsQuery,
		scope: MetricScope,
		format: "csv" | "parquet",
	): Promise<{ file: string; filename: string; closed: boolean }> {
		const def = AnalyticsService.definition(metric)
		const prepared = this.prepare(def, query, scope)
		const file = path.join(os.tmpdir(), `gezcez-export-${ulid()}.${format}`)
		await this.duckdb.withConnection(async (connection) => {
			const { sql } = await this.build(connection, def, prepared, scope)
			const options =
				format === "csv" ? "FORMAT csv, HEADER" : "FORMAT parquet, COMPRESSION zstd"
			await connection.run(`COPY (${sql}) TO ${sqlString(file)} (${options})`)
		})
		const { from, to } = prepared.params
		return {
			file,
			filename: `${def.key}_${from}_${to}.${format}`,
			closed: prepared.closed,
		}
	}

	/** True when a window of local dates ends before today (cacheable for a day). */
	isClosed(metric: string, query: AnalyticsQuery, scope: MetricScope): boolean {
		return this.prepare(AnalyticsService.definition(metric), query, scope).closed
	}

	// ---- per-connection views ---------------------------------------------------------------------

	private async build(
		connection: DuckDBConnection,
		def: MetricDef,
		prepared: Prepared,
		scope: MetricScope,
	): Promise<{ sql: string; source: Source }> {
		await connection.run(
			`CREATE OR REPLACE TEMP MACRO lt(t) AS timezone(${sqlString(scope.timezone)}, t::TIMESTAMPTZ)`,
		)
		const ctx = { params: prepared.params, days: prepared.days }
		const rollup = this.fleetRollup(def, prepared, scope)
		if (rollup) return { sql: rollup, source: "rollup" }
		let hot = false
		for (const view of def.views) {
			if (view === "routes") await this.routesView(connection, scope)
			else hot = (await this.datasetView(connection, view, prepared, scope)) || hot
		}
		return { sql: def.sql(ctx), source: hot ? "hot" : "archive" }
	}

	private async routesView(connection: DuckDBConnection, scope: MetricScope): Promise<void> {
		await connection.run(
			"CREATE OR REPLACE TEMP TABLE routes (region INTEGER, route_ext VARCHAR, short_name VARCHAR)",
		)
		await DuckDBService.append(
			connection,
			"routes",
			this.repository
				.activeRoutes(scope.bindingIds)
				.map((r) => [r.binding_id, r.route_ext, r.short_name]),
		)
	}

	/**
	 * Creates the `<dataset>` view for the window. Returns true when any row of the window came
	 * from vts.db (not archived yet).
	 */
	private async datasetView(
		connection: DuckDBConnection,
		dataset: Dataset,
		prepared: Prepared,
		scope: MetricScope,
	): Promise<boolean> {
		const { start, end } = prepared
		const spec = DATASET_SPECS[dataset]
		// Runs are archived by end date and filtered by start: look one day past the window.
		const lastDay = utcDayStart(utcDate(end - 1)) + (dataset === "trip_runs" ? 86400 : 0)
		const files: string[] = []
		const parts: string[] = []
		let hot = false
		// A network without bindings still gets an (empty) view.
		const regions = scope.bindingIds.length ? scope.bindingIds : [0]
		for (const region of regions) {
			const hotParts: Iterable<unknown[]>[] = []
			for (let day = utcDayStart(utcDate(start)); day <= lastDay; day += 86400) {
				const file = partitionFile(
					this.config.analytics.archiveDir,
					region,
					utcDate(day),
					dataset,
				)
				if (fs.existsSync(file)) {
					files.push(file)
					continue
				}
				if (dataset === "trip_runs") hotParts.push(this.vts.runs(region, day, day + 86400))
				else {
					const from = Math.max(day, start)
					const to = Math.min(day + 86400, end)
					if (from < to)
						hotParts.push(
							dataset === "positions"
								? this.vts.positions(region, from, to, false)
								: this.vts.polls(region, from, to),
						)
				}
			}
			if (dataset === "trip_runs") hotParts.push(this.vts.openRuns(region, start, end))
			const table = `stage_${dataset}_${region}`
			await connection.run(stagingDdl(dataset, table))
			// Days that are neither archived nor in vts.db are simply empty.
			if (await DuckDBService.append(connection, table, chain(hotParts))) hot = true
			parts.push(`SELECT ${region}::INTEGER AS region, ${spec.projection} FROM ${table}`)
		}
		if (files.length)
			parts.unshift(
				`SELECT CAST(region AS INTEGER) AS region, * EXCLUDE (region, date)
				 FROM read_parquet([${files.map(sqlString).join(", ")}], hive_partitioning = true)`,
			)
		const column = dataset === "positions" ? "feed_ts" : "started_at"
		const union = parts.join(" UNION ALL BY NAME ")
		await connection.run(
			`CREATE OR REPLACE TEMP VIEW ${dataset} AS SELECT * FROM (${union})
			 WHERE ${column} >= ${ts(start)} AND ${column} < ${ts(end)}`,
		)
		return hot
	}

	/** fleet.hourly at 1 h without route filters, from data/agg when every day is rolled up. */
	private fleetRollup(def: MetricDef, prepared: Prepared, scope: MetricScope): string | null {
		const p = prepared.params
		if (def.key !== "fleet.hourly" || p.granularity !== "1h") return null
		if (p.routes.length || p.direction !== undefined || !scope.bindingIds.length) return null
		const files: string[] = []
		for (const region of scope.bindingIds) {
			for (let day = utcDayStart(utcDate(prepared.start)); day < prepared.end; day += 86400) {
				const date = utcDate(day)
				const file = aggFile(this.config.analytics.aggDir, "fleet_hourly", region, date)
				if (fs.existsSync(file)) {
					files.push(file)
					continue
				}
				// A day without a rollup is fine only when it has no data at all.
				const archived = partitionFile(
					this.config.analytics.archiveDir,
					region,
					date,
					"positions",
				)
				if (fs.existsSync(archived)) return null
				if (this.vts.stats("positions", region, day, day + 86400).rows > 0) return null
			}
		}
		if (!files.length) return null
		return `
			SELECT strftime(b, '%Y-%m-%dT%H:%M') AS bucket, sum(vehicles)::INTEGER AS vehicles,
			       round(sum(vehicle_hours), 2) AS vehicle_hours, sum(peak_vehicles)::INTEGER AS peak_vehicles
			FROM (
				SELECT date_trunc('hour', lt(hour_utc)) AS b, vehicles, vehicle_hours, peak_vehicles
				FROM read_parquet([${files.map(sqlString).join(", ")}])
				WHERE hour_utc >= ${ts(prepared.start)} AND hour_utc < ${ts(prepared.end)}
				  AND ${filters(p, "hour_utc", { routes: false })}
			)
			GROUP BY b ORDER BY b`
	}

	/** First and last archived UTC dates of a set of bindings (from the archive folders). */
	archiveRange(bindingIds: number[]): { first_date: string | null; last_date: string | null } {
		const dates: string[] = []
		for (const region of bindingIds) {
			const dir = path.join(this.config.analytics.archiveDir, `region=${region}`)
			if (!fs.existsSync(dir)) continue
			for (const name of fs.readdirSync(dir))
				if (name.startsWith("date=")) dates.push(name.slice(5))
		}
		dates.sort()
		return { first_date: dates[0] ?? null, last_date: dates.at(-1) ?? null }
	}

	clearCache(): void {
		this.cache.clear()
	}
}
