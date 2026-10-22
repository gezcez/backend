import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { latLngToCell } from "h3-js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import type { TransitDatabase, VtsDatabase } from "@db"
import { runMigrations } from "@db/migrate"
import { openSqlite } from "@db/open-sqlite"
import * as transitSchema from "@schemas/transit"
import * as vtsSchema from "@schemas/vts"
import { partitionFile } from "@services/archive/archive.datasets"
import { ArchiveRepository } from "@services/archive/archive.repository"
import { ArchiveService } from "@services/archive/archive.service"
import { createUploader } from "@services/archive/archive.uploader"
import type { NetworksService } from "@services/networks/networks.service"
import {
	buildFixture,
	FIXTURE_TZ,
	insertFixture,
	POLLS_PER_DAY,
	POSITIONS_PER_DAY,
} from "@test/helpers/vts-fixtures"
import { AnalyticsQuerySchema, type MetricResult } from "./analytics.dto"
import { METRIC_KEYS } from "./analytics.queries"
import { AnalyticsRepository } from "./analytics.repository"
import { AnalyticsService } from "./analytics.service"
import { AggregatesJob } from "./aggregates.jobs"
import { aggFile } from "./aggregates.paths"
import { DuckDBService } from "./duckdb.service"

const MIGRATIONS = path.resolve(import.meta.dir, "../../../drizzle")
const D1 = "2026-10-19"
const D2 = "2026-10-20"
const BINDING = 7
const SCOPE = { bindingIds: [BINDING], timezone: FIXTURE_TZ }

let dir: string
let config: AppConfig
let vts: VtsDatabase
let duckdb: DuckDBService
let repository: ArchiveRepository
let archive: ArchiveService
let analytics: AnalyticsService

function query(extra: Record<string, string> = {}) {
	return AnalyticsQuerySchema.parse({ from: D1, to: D2, ...extra })
}

async function metric(key: string, extra: Record<string, string> = {}): Promise<MetricResult> {
	analytics.clearCache()
	return analytics.run(key, query(extra), SCOPE)
}

/** Rows as objects keyed by column name. */
function objects(result: MetricResult): Record<string, unknown>[] {
	return result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])))
}

function quantileCont(values: number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b)
	const pos = (sorted.length - 1) * q
	const lo = Math.floor(pos)
	const hi = Math.ceil(pos)
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-analytics-"))
	config = loadConfig({
		NODE_ENV: "test",
		DATA_DIR: dir,
		MIGRATIONS_DIR: MIGRATIONS,
		LOG_LEVEL: "silent",
		ARCHIVE_UPLOAD: "local",
		ARCHIVE_MIRROR_DIR: path.join(dir, "mirror"),
	})
	const vtsSqlite = openSqlite(path.join(dir, "vts.db"), { incrementalVacuum: true })
	runMigrations(vtsSqlite, path.join(MIGRATIONS, "vts"), dir)
	vts = drizzle({ client: vtsSqlite, schema: vtsSchema }) as VtsDatabase
	const transitSqlite = openSqlite(path.join(dir, "transit.db"))
	runMigrations(transitSqlite, path.join(MIGRATIONS, "transit"), dir)
	const transit = drizzle({ client: transitSqlite, schema: transitSchema }) as TransitDatabase
	insertFixture(vtsSqlite, BINDING, buildFixture([D1, D2]))
	duckdb = new DuckDBService(config)
	repository = new ArchiveRepository(vts)
	archive = new ArchiveService(config, repository, duckdb, createUploader(config.analytics))
	analytics = new AnalyticsService(config, duckdb, repository, new AnalyticsRepository(transit))
})

afterAll(() => {
	duckdb.onApplicationShutdown()
	fs.rmSync(dir, { recursive: true, force: true })
})

describe("DuckDB under Bun", () => {
	test("loads, queries and registers gz_h3", async () => {
		const result = await duckdb.withConnection((c) =>
			DuckDBService.query(c, "SELECT 42::INTEGER AS x, gz_h3(40.76, 29.92, 8) AS cell"),
		)
		expect(result.rows[0]).toEqual([42, latLngToCell(40.76, 29.92, 8)])
	})

	test("interrupts a query past its timeout with ANALYTICS_TIMEOUT", async () => {
		const run = duckdb.withConnection(
			(c) => DuckDBService.query(c, "SELECT count(*) FROM range(10000000000)"),
			{ timeoutMs: 100 },
		)
		await expect(run).rejects.toMatchObject({ code: "ANALYTICS_TIMEOUT" })
	})
})

describe("archive export", () => {
	test("exports, verifies, hashes and uploads a day", async () => {
		const result = await archive.exportDay(BINDING, D1)
		expect(result.skipped).toBe(false)
		const byDataset = Object.fromEntries(result.datasets.map((d) => [d.dataset, d]))
		expect(byDataset.positions).toMatchObject({
			rows: POSITIONS_PER_DAY,
			verified: true,
			uploaded: true,
			error: null,
		})
		expect(byDataset.trip_runs).toMatchObject({ rows: 5, verified: true, uploaded: true })
		expect(byDataset.polls).toMatchObject({
			rows: POLLS_PER_DAY,
			verified: true,
			uploaded: true,
		})
		const file = partitionFile(config.analytics.archiveDir, BINDING, D1, "positions")
		expect(fs.existsSync(file)).toBe(true)
		expect(fs.existsSync(`${file}.tmp`)).toBe(false)
		const hash = new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex")
		expect(byDataset.positions!.sha256).toBe(hash)
		expect(
			fs.existsSync(
				path.join(dir, "mirror", `region=${BINDING}/date=${D1}/positions.parquet`),
			),
		).toBe(true)
		const manifest = repository.manifestFor(BINDING, D1)
		expect(manifest).toHaveLength(3)
		for (const row of manifest) {
			expect(row.verified_at).not.toBeNull()
			expect(row.uploaded_at).not.toBeNull()
		}
		// Retention may now delete D1, and only D1.
		expect(repository.verifiedDays()).toEqual([{ binding_id: BINDING, date: D1 }])
	})

	test("parquet columns and types follow the plan", async () => {
		const file = partitionFile(config.analytics.archiveDir, BINDING, D1, "positions")
		const result = await duckdb.withConnection((c) =>
			DuckDBService.query(
				c,
				`SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet('${file}', hive_partitioning = false))`,
			),
		)
		expect(Object.fromEntries(result.rows as [string, string][])).toEqual({
			vehicle_id: "INTEGER",
			vehicle_ext: "VARCHAR",
			plate: "VARCHAR",
			vehicle_ts: "TIMESTAMP",
			feed_ts: "TIMESTAMP",
			route_ext: "VARCHAR",
			direction: "TINYINT",
			trip_ext: "VARCHAR",
			stop_ext: "VARCHAR",
			stop_seq: "SMALLINT",
			status: "TINYINT",
			lat_e6: "INTEGER",
			lon_e6: "INTEGER",
			bearing_d10: "SMALLINT",
			speed_cms: "SMALLINT",
			quality: "UTINYINT",
		})
	})

	test("a failed verification keeps the temp file and leaves verified_at empty", async () => {
		const lying = Object.create(repository) as ArchiveRepository
		lying.stats = (dataset, b, from, to) => {
			const real = repository.stats(dataset, b, from, to)
			return dataset === "polls" ? { ...real, rows: real.rows + 1 } : real
		}
		const broken = new ArchiveService(config, lying, duckdb, createUploader(config.analytics))
		const result = await broken.exportDay(BINDING, "2026-10-20")
		const polls = result.datasets.find((d) => d.dataset === "polls")!
		expect(polls.verified).toBe(false)
		expect(polls.error).toContain("verification failed")
		const file = partitionFile(config.analytics.archiveDir, BINDING, D2, "polls")
		expect(fs.existsSync(file)).toBe(false)
		expect(fs.existsSync(`${file}.tmp`)).toBe(true)
		const row = repository.manifestFor(BINDING, D2).find((m) => m.dataset === "polls")!
		expect(row.verified_at).toBeNull()
		expect(repository.verifiedDays().map((d) => d.date)).toEqual([D1])
		// Leave D2 hot for the analytics tests.
		for (const dataset of ["positions", "trip_runs"] as const)
			fs.rmSync(partitionFile(config.analytics.archiveDir, BINDING, D2, dataset), {
				force: true,
			})
		fs.rmSync(`${file}.tmp`)
	})

	test("a day without data is skipped", async () => {
		expect((await archive.exportDay(BINDING, "2026-01-01")).skipped).toBe(true)
	})
})

describe("metrics over one archived (D1) and one hot (D2) day", () => {
	test("fleet.hourly: vehicles, vehicle-hours and peak per day and hour", async () => {
		const daily = await metric("fleet.hourly", { granularity: "1d" })
		expect(daily.meta.source).toBe("hot")
		expect(daily.columns).toEqual(["bucket", "vehicles", "vehicle_hours", "peak_vehicles"])
		expect(daily.rows).toEqual([
			[D1, 4, 1.5, 3],
			[D2, 4, 1.5, 3],
		])
		const hourly = await metric("fleet.hourly", { date: D1 })
		expect(hourly.meta.source).toBe("archive")
		expect(hourly.rows).toEqual([
			[`${D1}T08:00`, 3, 1.33, 3],
			[`${D1}T09:00`, 1, 0.17, 1],
		])
		const fine = await metric("fleet.hourly", { date: D1, granularity: "5m", route_id: "R2" })
		expect(fine.rows).toEqual([
			[`${D1}T09:00`, 1, 0.08, 1],
			[`${D1}T09:05`, 1, 0.08, 1],
		])
	})

	test("fleet.vehicle-days: duty span per vehicle and day", async () => {
		const rows = objects(await metric("fleet.vehicle-days"))
		expect(rows).toHaveLength(8)
		const v1 = rows.find((r) => r.date === D1 && r.vehicle_ext === "V1")!
		expect(v1).toMatchObject({
			first_seen: `${D1}T08:00:00`,
			last_seen: `${D1}T08:42:00`,
			duty_hours: 0.7,
			samples: 36,
			routes: 1,
			new_in_window: false,
			retired_in_window: false,
		})
		const v3 = rows.find((r) => r.date === D2 && r.vehicle_ext === "V3")!
		expect(v3).toMatchObject({ samples: 10, duty_hours: 0.15 })
	})

	test("runs.runtime: p50/p90 per route-direction-hour, short runs excluded", async () => {
		const result = await metric("runs.runtime")
		expect(result.columns).toEqual([
			"route_ext",
			"direction",
			"hour",
			"runs",
			"p50_min",
			"p90_min",
			"mean_min",
		])
		expect(result.rows).toEqual([["R1", 0, 8, 8, 17, 17, 17]])
		const all = await metric("runs.runtime", { min_stops: "0" })
		expect(all.rows).toEqual([
			["R1", 0, 8, 8, 17, 17, 17],
			["R2", 1, 9, 2, 9, 9, 9],
		])
	})

	test("runs.departures: starts per route-direction and day", async () => {
		expect((await metric("runs.departures")).rows).toEqual([
			[D1, "R1", 0, 4],
			[D1, "R2", 1, 1],
			[D2, "R1", 0, 4],
			[D2, "R2", 1, 1],
		])
	})

	test("headways.observed: median headway and bunching share", async () => {
		const rows = objects(await metric("headways.observed"))
		// R1 every stop: headways 10, 12 and 3 min per day; R2 has one trip a day (no headway).
		expect(rows.map((r) => r.stop_ext)).toEqual(["S1", "S2", "S3", "S4", "S5"])
		for (const row of rows)
			expect(row).toMatchObject({
				route_ext: "R1",
				direction: 0,
				hour: 8,
				n: 6,
				median_headway_min: 10,
				p90_headway_min: 12,
				bunching_share: 0.333,
				gap_share: 0,
			})
	})

	test("adherence.departure: delay vs timetable and on-time share", async () => {
		const rows = objects(await metric("adherence.departure"))
		expect(rows).toEqual([
			{
				route_ext: "R1",
				short_name: null,
				direction: 0,
				hour: 8,
				runs: 6,
				median_delay_min: 1,
				p90_delay_min: 4,
				on_time_share: 0.667,
				early_share: 0.333,
				late_share: 0,
			},
			{
				route_ext: "R2",
				short_name: null,
				direction: 1,
				hour: 9,
				runs: 2,
				median_delay_min: 0,
				p90_delay_min: 0,
				on_time_share: 1,
				early_share: 0,
				late_share: 0,
			},
		])
	})

	test("speed.heatmap: median and p15 km/h per H3 cell", async () => {
		const result = await metric("speed.heatmap", { min_samples: "1" })
		expect(result.columns).toEqual(["h3", "median_kmh", "p15_kmh", "n"])
		const data = buildFixture([D1, D2])
		const cells = new Map<string, number[]>()
		for (const p of data.positions) {
			if (p.quality !== 0) continue
			const cell = latLngToCell(
				(Math.floor(p.lat_e6 / 100) + 0.5) / 1e4,
				(Math.floor(p.lon_e6 / 100) + 0.5) / 1e4,
				8,
			)
			cells.set(cell, [...(cells.get(cell) ?? []), p.speed_cms * 0.036])
		}
		const expected = [...cells.entries()]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([cell, speeds]) => [
				cell,
				Math.round(quantileCont(speeds, 0.5) * 100) / 100,
				Math.round(quantileCont(speeds, 0.15) * 100) / 100,
				speeds.length,
			])
		expect(result.rows).toEqual(expected)
		const filtered = await metric("speed.heatmap", { min_samples: "1", hour: "9" })
		expect(filtered.rows.reduce((sum, row) => sum + (row[3] as number), 0)).toBe(20)
	})

	test("segments.travel-time: 240 s between consecutive stops", async () => {
		const rows = objects(await metric("segments.travel-time", { route_id: "R1" }))
		expect(rows.map((r) => [r.from_stop, r.to_stop])).toEqual([
			["S1", "S2"],
			["S2", "S3"],
			["S3", "S4"],
			["S4", "S5"],
		])
		for (const row of rows)
			expect(row).toMatchObject({ hour: 8, n: 8, median_s: 240, p90_s: 240 })
	})

	test("dwell.stops: STOPPED_AT run lengths", async () => {
		const top = objects(await metric("dwell.stops"))
		expect(top).toHaveLength(8)
		for (const row of top) expect(row).toMatchObject({ median_dwell_s: 60, p90_dwell_s: 60 })
		expect(top.find((r) => r.stop_ext === "S3")!.n).toBe(8)
		expect(top.find((r) => r.stop_ext === "Q2")!.n).toBe(2)
		const one = await metric("dwell.stops", { stop_id: "7.S1" })
		expect(one.columns).toEqual(["stop_ext", "hour", "n", "median_dwell_s", "p90_dwell_s"])
		expect(one.rows).toEqual([["S1", 8, 8, 60, 60]])
	})

	test("quality.feed: poll success, lag, stale share and score", async () => {
		const rows = objects(await metric("quality.feed"))
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({
			date: D1,
			binding_id: BINDING,
			polls: POLLS_PER_DAY,
			success_rate: Math.round((100 / 101) * 10000) / 10000,
			gap_minutes: 0,
			positions: POSITIONS_PER_DAY,
			vehicles: 4,
			lag_p50_s: 15,
			stale_share: Math.round((1 / POSITIONS_PER_DAY) * 10000) / 10000,
			outlier_share: 0,
			routes_seen: 2,
			catalog_routes: 0,
			coverage: null,
			dropped_test: 2,
			dropped_staff: 1,
		})
		expect(rows[1]).toMatchObject({ date: D2, success_rate: 1 })
		const score = 100 * (0.4 * 1 + 0.3 * (1 - 1 / POSITIONS_PER_DAY) + 0.2 + 0.1)
		expect(rows[1]!.score).toBe(Math.round(score * 10) / 10)
	})

	test("coverage.routes: routes seen without a catalogue", async () => {
		const rows = objects(await metric("coverage.routes"))
		expect(rows.map((r) => [r.route_ext, r.in_catalog, r.days_seen, r.days_in_window])).toEqual(
			[
				["R1", false, 2, 2],
				["R2", false, 2, 2],
			],
		)
	})

	test("headways.marey: one series per vehicle trip", async () => {
		const result = await metric("headways.marey", { date: D2, route_id: "R1", direction: "0" })
		expect(result.columns).toEqual(["vehicle_id", "trip_ext", "t", "stop_seq"])
		expect(result.rows).toHaveLength(4 * 18)
		expect(new Set(result.rows.map((r) => r[1]))).toEqual(new Set(["T1", "T2", "T3", "T4"]))
	})

	test("hot and archived days give identical answers", async () => {
		const before: Record<string, unknown> = {}
		for (const key of METRIC_KEYS) {
			const extra: Record<string, string> =
				key === "headways.marey"
					? { date: D2, route_id: "R1", direction: "0" }
					: { date: D2, min_samples: "1" }
			const result = await metric(key, extra)
			expect(result.meta.source).toBe("hot")
			before[key] = { columns: result.columns, rows: result.rows }
		}
		const exported = await archive.exportDay(BINDING, D2)
		expect(exported.datasets.every((d) => d.verified)).toBe(true)
		for (const key of METRIC_KEYS) {
			const extra: Record<string, string> =
				key === "headways.marey"
					? { date: D2, route_id: "R1", direction: "0" }
					: { date: D2, min_samples: "1" }
			const result = await metric(key, extra)
			// Runs are archived by end date: the next UTC day is still "hot" (empty) for them.
			if (!["runs.runtime", "runs.departures", "adherence.departure"].includes(key))
				expect(result.meta.source).toBe("archive")
			expect({ columns: result.columns, rows: result.rows }).toEqual(before[key] as never)
		}
	})
})

describe("aggregates and parameters", () => {
	test("nightly aggregates feed fleet.hourly as a rollup with the same answer", async () => {
		const live = await metric("fleet.hourly")
		const networks = {
			bindingContext: () => ({ timezone: FIXTURE_TZ }),
		} as unknown as NetworksService
		const job = new AggregatesJob(config, duckdb, repository, networks)
		const run = await job.run(Date.parse(`${D2}T12:00:00Z`))
		expect(run).toEqual({ days: 2, weeks: 1, failures: 0 })
		expect(fs.existsSync(aggFile(config.analytics.aggDir, "headways", BINDING, D1))).toBe(true)
		const rollup = await metric("fleet.hourly")
		expect(rollup.meta.source).toBe("rollup")
		expect(rollup.rows).toEqual(live.rows)
		// A second run finds nothing stale.
		expect(await job.run(Date.parse(`${D2}T12:00:00Z`))).toEqual({
			days: 0,
			weeks: 0,
			failures: 0,
		})
	})

	test("CSV and Parquet exports", async () => {
		const csv = await analytics.export("runs.departures", query(), SCOPE, "csv")
		expect(fs.readFileSync(csv.file, "utf8").trim().split("\n")).toEqual([
			"date,route_ext,direction,departures",
			`${D1},R1,0,4`,
			`${D1},R2,1,1`,
			`${D2},R1,0,4`,
			`${D2},R2,1,1`,
		])
		expect(csv.filename).toBe(`runs.departures_${D1}_${D2}.csv`)
		const parquet = await analytics.export("runs.departures", query(), SCOPE, "parquet")
		expect(fs.readFileSync(parquet.file).subarray(0, 4).toString()).toBe("PAR1")
		fs.rmSync(csv.file)
		fs.rmSync(parquet.file)
	})

	test("window and metric parameter validation", async () => {
		await expect(analytics.run("nope", query(), SCOPE)).rejects.toMatchObject({
			code: "NOT_FOUND",
		})
		const long = AnalyticsQuerySchema.parse({ from: "2026-01-01", to: "2026-06-01" })
		await expect(analytics.run("fleet.hourly", long, SCOPE)).rejects.toBeInstanceOf(GezcezError)
		await expect(analytics.run("fleet.hourly", long, SCOPE)).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
		})
		await expect(analytics.run("headways.marey", query(), SCOPE)).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
		})
		expect(AnalyticsQuerySchema.safeParse({ route_id: "R1'; DROP" }).success).toBe(false)
	})
})
