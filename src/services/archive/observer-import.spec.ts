import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, type AppConfig } from "@common/config"
import type { TransitDatabase, VtsDatabase } from "@db"
import { runMigrations } from "@db/migrate"
import { openSqlite } from "@db/open-sqlite"
import * as transitSchema from "@schemas/transit"
import * as vtsSchema from "@schemas/vts"
import { AnalyticsQuerySchema } from "@services/analytics/analytics.dto"
import { AnalyticsRepository } from "@services/analytics/analytics.repository"
import { AnalyticsService } from "@services/analytics/analytics.service"
import { DuckDBService } from "@services/analytics/duckdb.service"
import {
	OBSERVER_DAY,
	OBSERVER_FEEDS,
	OBSERVER_NEXT,
	writeObserverDb,
	type ObserverExpectation,
} from "@test/helpers/observer-fixture"
import { partitionFile } from "./archive.datasets"
import { ArchiveRepository } from "./archive.repository"
import { ArchiveService } from "./archive.service"
import { createUploader } from "./archive.uploader"
import { ObserverImport, type ObserverImportReport } from "./observer-import"
import { ObserverRepository } from "./observer.repository"

const MIGRATIONS = path.resolve(import.meta.dir, "../../../drizzle")
const BINDING = 4

let dir: string
let config: AppConfig
let vtsSqlite: ReturnType<typeof openSqlite>
let duckdb: DuckDBService
let repository: ArchiveRepository
let archive: ArchiveService
let analytics: AnalyticsService
let expected: ObserverExpectation
let source: ObserverRepository
let report: ObserverImportReport

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-observer-"))
	config = loadConfig({
		NODE_ENV: "test",
		DATA_DIR: dir,
		MIGRATIONS_DIR: MIGRATIONS,
		LOG_LEVEL: "silent",
		ARCHIVE_UPLOAD: "local",
		ARCHIVE_MIRROR_DIR: path.join(dir, "mirror"),
	})
	vtsSqlite = openSqlite(path.join(dir, "vts.db"), { incrementalVacuum: true })
	runMigrations(vtsSqlite, path.join(MIGRATIONS, "vts"), dir)
	const vts = drizzle({ client: vtsSqlite, schema: vtsSchema }) as VtsDatabase
	const transitSqlite = openSqlite(path.join(dir, "transit.db"))
	runMigrations(transitSqlite, path.join(MIGRATIONS, "transit"), dir)
	const transit = drizzle({ client: transitSqlite, schema: transitSchema }) as TransitDatabase
	duckdb = new DuckDBService(config)
	repository = new ArchiveRepository(vts)
	archive = new ArchiveService(config, repository, duckdb, createUploader(config.analytics))
	analytics = new AnalyticsService(config, duckdb, repository, new AnalyticsRepository(transit))
	const file = path.join(dir, "VTS.db")
	expected = writeObserverDb(file)
	source = new ObserverRepository(file)
	report = await new ObserverImport(archive, repository).run(source, { bindingId: BINDING })
}, 60_000)

afterAll(() => {
	source.close()
	duckdb.onApplicationShutdown()
	fs.rmSync(dir, { recursive: true, force: true })
})

async function parquet(sql: string) {
	return duckdb.withConnection((c) => DuckDBService.query(c, sql))
}

const file = (date: string, dataset: "positions" | "trip_runs" | "polls") =>
	partitionFile(config.analytics.archiveDir, BINDING, date, dataset)

describe("observer history import", () => {
	test("dedups, filters staff, test and invalid rows", () => {
		expect(report).toMatchObject({
			binding_id: BINDING,
			read: expected.read,
			duplicates: expected.duplicates,
			staff: expected.staff,
			test: expected.test,
			invalid: expected.invalid,
			kept: expected.positions[OBSERVER_DAY]! + expected.positions[OBSERVER_NEXT]!,
		})
		expect(report.days.map((d) => d.date)).toEqual([OBSERVER_DAY, OBSERVER_NEXT])
		for (const day of report.days) {
			expect(day.skipped).toBe(false)
			expect(day.datasets.map((d) => d.dataset).sort()).toEqual([
				"polls",
				"positions",
				"trip_runs",
			])
			for (const d of day.datasets)
				expect(d).toMatchObject({ verified: true, uploaded: true })
		}
	})

	test("writes verified partitions with the archive layout and manifest", async () => {
		for (const date of [OBSERVER_DAY, OBSERVER_NEXT]) {
			const result = await parquet(
				`SELECT count(*)::INTEGER, count(DISTINCT (vehicle_id, vehicle_ts))::INTEGER
				 FROM read_parquet('${file(date, "positions")}', hive_partitioning = false)`,
			)
			expect(result.rows[0]).toEqual([expected.positions[date]!, expected.positions[date]!])
			const manifest = repository.manifestFor(BINDING, date)
			expect(manifest).toHaveLength(3)
			for (const row of manifest) expect(row.verified_at).not.toBeNull()
		}
		const polls = await parquet(
			`SELECT count(*)::INTEGER FROM read_parquet(['${file(OBSERVER_DAY, "polls")}', '${file(OBSERVER_NEXT, "polls")}'])`,
		)
		expect(polls.rows[0]).toEqual([OBSERVER_FEEDS])
	})

	test("maps vehicles to vts.db ids and sets quality bits", async () => {
		const vehicles = vtsSqlite
			.query<{ external_id: string }, [number]>(
				"SELECT external_id FROM vehicles WHERE binding_id = ? ORDER BY external_id",
			)
			.all(BINDING)
		expect(vehicles.map((v) => v.external_id)).toEqual(expected.vehicles)
		const quality = await parquet(
			`SELECT vehicle_ext, bool_and(quality & 1 = 1)::BOOLEAN, count(*) FILTER (WHERE quality & 2 = 2)::INTEGER
			 FROM read_parquet(['${file(OBSERVER_DAY, "positions")}', '${file(OBSERVER_NEXT, "positions")}'])
			 GROUP BY vehicle_ext ORDER BY vehicle_ext`,
		)
		// 1007 lags 700 s (stale) and jumps out and back once.
		expect(quality.rows).toEqual([
			["1001", false, 0],
			["1002", false, 0],
			["1007", true, 2],
		])
	})

	test("rebuilds trip runs: trip change at midnight, open runs end as disappeared", async () => {
		const runs = await parquet(
			`SELECT vehicle_ext, trip_ext, keyed_by_route, end_reason, strftime(ended_at, '%Y-%m-%d')
			 FROM read_parquet(['${file(OBSERVER_DAY, "trip_runs")}', '${file(OBSERVER_NEXT, "trip_runs")}'])
			 ORDER BY vehicle_ext, started_at`,
		)
		expect(runs.rows).toEqual([
			["1001", "7001", false, "disappeared", OBSERVER_NEXT],
			["1002", "7002", false, "trip_change", OBSERVER_DAY],
			["1002", "7003", false, "disappeared", OBSERVER_NEXT],
			["1007", null, true, "disappeared", OBSERVER_NEXT],
		])
	})

	test("analytics reads the imported days", async () => {
		const result = await analytics.run(
			"fleet.hourly",
			AnalyticsQuerySchema.parse({
				from: OBSERVER_DAY,
				to: OBSERVER_NEXT,
				granularity: "1d",
			}),
			{ bindingIds: [BINDING], timezone: "UTC" },
		)
		expect(result.meta.source).toBe("archive")
		// 1007 is stale throughout, so fleet counts only 1001 and 1002.
		expect(result.rows.map((r) => [r[0], r[1]])).toEqual([
			[OBSERVER_DAY, 2],
			[OBSERVER_NEXT, 2],
		])
	})

	test("a re-run skips verified days unless forced", async () => {
		const importer = new ObserverImport(archive, repository)
		const again = await importer.run(source, { bindingId: BINDING })
		expect(again.days.every((d) => d.skipped)).toBe(true)
		const forced = await importer.run(source, {
			bindingId: BINDING,
			force: true,
			to: OBSERVER_DAY,
		})
		expect(forced.days.map((d) => [d.date, d.skipped])).toEqual([
			[OBSERVER_DAY, false],
			[OBSERVER_NEXT, true],
		])
	})
})
