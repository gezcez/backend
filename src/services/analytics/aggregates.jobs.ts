// aggregates.jobs.ts
// Nightly materialised aggregates (plan 6.9) written from the verified Parquet archive into
// data/agg: fleet_hourly and headways per (region, UTC date), segment_times per (region, ISO
// week). fleet.hourly at 1 h reads fleet_hourly; segment_times feeds ETA. Rebuilt when missing
// or older than the archive file, so a re-export refreshes them the next night.

import { Injectable, Logger } from "@nestjs/common"
import type { DuckDBConnection } from "@duckdb/node-api"
import fs from "node:fs"
import path from "node:path"
import { InjectConfig, type AppConfig } from "@common/config"
import { isoWeek, isoWeekStart, partitionFile, utcDate } from "@services/archive/archive.datasets"
import { ArchiveRepository } from "@services/archive/archive.repository"
import { NetworksService } from "@services/networks/networks.service"
import { METRICS, type MetricParams } from "./analytics.queries"
import { aggFile, aggWeekFile } from "./aggregates.paths"
import { DuckDBService, sqlString } from "./duckdb.service"

/** Days back the nightly job looks for archive days without aggregates. */
const LOOKBACK_DAYS = 35
const DEFAULT_TZ = "Europe/Istanbul"

function allDayParams(date: string): MetricParams {
	return {
		from: date,
		to: date,
		routes: [],
		day_type: "all",
		hour_from: 0,
		hour_to: 23,
		granularity: "1h",
		res: 8,
		min_samples: 1,
		min_stops: 0,
		limit: 100,
	}
}

export interface AggregatesRun {
	days: number
	weeks: number
	failures: number
}

@Injectable()
export class AggregatesJob {
	private readonly logger = new Logger("Aggregates")
	private running: Promise<AggregatesRun> | undefined

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly duckdb: DuckDBService,
		private readonly archive: ArchiveRepository,
		private readonly networks: NetworksService,
	) {}

	private timezone(region: number): string {
		try {
			return this.networks.bindingContext(region).timezone
		} catch {
			return DEFAULT_TZ
		}
	}

	private positionsFile(region: number, date: string): string {
		return partitionFile(this.config.analytics.archiveDir, region, date, "positions")
	}

	private stale(target: string, source: string): boolean {
		if (!fs.existsSync(target)) return true
		return fs.statSync(target).mtimeMs < fs.statSync(source).mtimeMs
	}

	run(now = Date.now()): Promise<AggregatesRun> {
		this.running ??= this.runOnce(now).finally(() => {
			this.running = undefined
		})
		return this.running
	}

	private async runOnce(now: number): Promise<AggregatesRun> {
		const since = utcDate(Math.floor(now / 1000) - LOOKBACK_DAYS * 86400)
		const weeks = new Map<string, { region: number; week: string; start: string }>()
		let days = 0
		let failures = 0
		for (const day of this.archive.verifiedDays()) {
			if (day.date < since) continue
			const source = this.positionsFile(day.binding_id, day.date)
			if (!fs.existsSync(source)) continue
			const fleet = aggFile(
				this.config.analytics.aggDir,
				"fleet_hourly",
				day.binding_id,
				day.date,
			)
			if (!this.stale(fleet, source)) continue
			try {
				await this.buildDay(day.binding_id, day.date)
				days++
				const week = isoWeek(day.date)
				weeks.set(`${day.binding_id}:${week}`, {
					region: day.binding_id,
					week,
					start: isoWeekStart(day.date),
				})
			} catch (error) {
				failures++
				this.logger.warn(
					`aggregates ${day.binding_id}:${day.date} failed: ${(error as Error).message}`,
				)
			}
		}
		for (const { region, week, start } of weeks.values()) {
			try {
				await this.buildWeek(region, week, start)
			} catch (error) {
				failures++
				this.logger.warn(
					`segment times ${region}:${week} failed: ${(error as Error).message}`,
				)
			}
		}
		if (days || failures)
			this.logger.log(`aggregates: ${days} days, ${weeks.size} weeks, ${failures} failures`)
		return { days, weeks: weeks.size, failures }
	}

	private async positionsView(
		connection: DuckDBConnection,
		region: number,
		files: string[],
	): Promise<void> {
		await connection.run(
			`CREATE OR REPLACE TEMP MACRO lt(t) AS timezone(${sqlString(this.timezone(region))}, t::TIMESTAMPTZ)`,
		)
		await connection.run(
			`CREATE OR REPLACE TEMP VIEW positions AS
			 SELECT CAST(region AS INTEGER) AS region, * EXCLUDE (region, date)
			 FROM read_parquet([${files.map(sqlString).join(", ")}], hive_partitioning = true)`,
		)
	}

	private async copy(connection: DuckDBConnection, sql: string, target: string): Promise<void> {
		fs.mkdirSync(path.dirname(target), { recursive: true })
		const tmp = `${target}.tmp`
		await connection.run(
			`COPY (${sql}) TO ${sqlString(tmp)} (FORMAT parquet, COMPRESSION zstd)`,
		)
		fs.renameSync(tmp, target)
	}

	/** fleet_hourly and headways for one archived (region, UTC date). */
	async buildDay(region: number, date: string): Promise<void> {
		const source = this.positionsFile(region, date)
		const aggDir = this.config.analytics.aggDir
		await this.duckdb.withConnection(
			async (connection) => {
				await this.positionsView(connection, region, [source])
				// Each hour belongs to the date of its vehicle_ts, so a late row in the next
				// day's file never counts a vehicle twice when days are summed.
				await this.copy(
					connection,
					`WITH s AS (
						SELECT DISTINCT vehicle_id, time_bucket(INTERVAL 5 MINUTE, vehicle_ts) AS slot
						FROM positions WHERE quality & 3 = 0 AND vehicle_ts::DATE = DATE ${sqlString(date)}
					), ps AS (
						SELECT slot, count(*) AS v FROM s GROUP BY slot
					)
					SELECT h.hour_utc, h.vehicles, h.vehicle_hours, p.peak_vehicles
					FROM (
						SELECT date_trunc('hour', slot) AS hour_utc,
						       count(DISTINCT vehicle_id)::INTEGER AS vehicles,
						       round(count(*) / 12.0, 2) AS vehicle_hours
						FROM s GROUP BY 1
					) h JOIN (
						SELECT date_trunc('hour', slot) AS hour_utc, max(v)::INTEGER AS peak_vehicles
						FROM ps GROUP BY 1
					) p USING (hour_utc)
					ORDER BY hour_utc`,
					aggFile(aggDir, "fleet_hourly", region, date),
				)
				const params = allDayParams(date)
				await this.copy(
					connection,
					METRICS["headways.observed"].sql({ params, days: 1 }),
					aggFile(aggDir, "headways", region, date),
				)
			},
			{ timeoutMs: null },
		)
	}

	/** segment_times over every archived day of one ISO week. */
	async buildWeek(region: number, week: string, start: string): Promise<void> {
		const files: string[] = []
		for (let i = 0; i < 7; i++) {
			const date = utcDate(Date.parse(`${start}T00:00:00Z`) / 1000 + i * 86400)
			const file = this.positionsFile(region, date)
			if (fs.existsSync(file)) files.push(file)
		}
		if (!files.length) return
		await this.duckdb.withConnection(
			async (connection) => {
				await this.positionsView(connection, region, files)
				const params = allDayParams(start)
				await this.copy(
					connection,
					`SELECT *, ${sqlString(week)} AS week FROM (${METRICS["segments.travel-time"].sql({ params, days: 7 })})`,
					aggWeekFile(this.config.analytics.aggDir, region, week),
				)
			},
			{ timeoutMs: null },
		)
	}
}
