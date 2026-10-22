// archive.service.ts
// Daily Parquet export of vts.db (plan 5.4 and 8.8). Per (binding, UTC date, dataset):
// stream rows from vts.db into a DuckDB staging table, COPY to `<dataset>.parquet.tmp`, read the
// temp file back and compare count and min/max with an independent SQLite count, hash it,
// rename it, upsert archive_manifest (verified_at), upload it and HEAD-check the size
// (uploaded_at). Tracker retention deletes hot positions only for days with both stamps.
// Idempotent: a rerun overwrites the files and the manifest. A failure leaves the temp file and
// a manifest row without verified_at, so retention keeps that day and the next night retries it.

import { Inject, Injectable, Logger } from "@nestjs/common"
import fs from "node:fs"
import path from "node:path"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { DuckDBService, sqlString } from "@services/analytics/duckdb.service"
import { trackerRunner } from "@services/tracker/tracker-host.service"
import {
	DATASET_SPECS,
	DATASETS,
	partitionFile,
	partitionKey,
	stagingDdl,
	utcDate,
	utcDayStart,
	type Dataset,
} from "./archive.datasets"
import { ArchiveRepository, type ManifestFilter, type ManifestRow } from "./archive.repository"
import { ARCHIVE_UPLOADER, type ArchiveUploader } from "./archive.uploader"

export interface DatasetExport {
	dataset: Dataset
	rows: number
	bytes: number
	sha256: string | null
	verified: boolean
	uploaded: boolean
	error: string | null
}

export interface DayExport {
	binding_id: number
	date: string
	skipped: boolean
	datasets: DatasetExport[]
}

export interface NightlyRun {
	started_at: number
	finished_at: number
	days: number
	failures: number
	uploads_retried: number
	pruned: number
}

const SLACK_S = 5 * 60

@Injectable()
export class ArchiveService {
	private readonly logger = new Logger("Archive")
	private readonly inFlight = new Set<string>()
	private nightly: Promise<NightlyRun> | undefined
	private failedNights = 0
	lastRun: NightlyRun | null = null

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: ArchiveRepository,
		private readonly duckdb: DuckDBService,
		@Inject(ARCHIVE_UPLOADER) readonly uploader: ArchiveUploader,
	) {}

	/** This process owns vts.db writes (single-writer rule): not MODE=api. */
	get canWrite(): boolean {
		return trackerRunner(this.config) !== "external"
	}

	private get root(): string {
		return this.config.analytics.archiveDir
	}

	manifest(filter: ManifestFilter): ManifestRow[] {
		return this.repository.listManifest(filter)
	}

	/** Exports one binding's UTC date. Throws CONFLICT when the same day is already running. */
	async exportDay(bindingId: number, date: string): Promise<DayExport> {
		if (!this.canWrite)
			throw new GezcezError("CONFLICT", "The archive export runs in the tracker process")
		const key = `${bindingId}:${date}`
		if (this.inFlight.has(key)) throw new GezcezError("CONFLICT", "Export already running")
		this.inFlight.add(key)
		try {
			const from = utcDayStart(date)
			const to = from + 86400
			const stats = DATASETS.map((dataset) => ({
				dataset,
				stats: this.repository.stats(dataset, bindingId, from, to),
			}))
			if (stats.every((s) => s.stats.rows === 0))
				return { binding_id: bindingId, date, skipped: true, datasets: [] }
			const datasets: DatasetExport[] = []
			for (const { dataset, stats: expected } of stats)
				datasets.push(await this.exportDataset(bindingId, date, dataset, expected))
			const failed = datasets.filter((d) => d.error)
			if (failed.length)
				this.logger.warn(
					`export ${key} failed: ${failed.map((d) => `${d.dataset}: ${d.error}`).join("; ")}`,
				)
			return { binding_id: bindingId, date, skipped: false, datasets }
		} finally {
			this.inFlight.delete(key)
		}
	}

	private async exportDataset(
		bindingId: number,
		date: string,
		dataset: Dataset,
		expected: { rows: number; min: number | null; max: number | null },
	): Promise<DatasetExport> {
		const file = partitionFile(this.root, bindingId, date, dataset)
		const tmp = `${file}.tmp`
		const from = utcDayStart(date)
		const result: DatasetExport = {
			dataset,
			rows: 0,
			bytes: 0,
			sha256: null,
			verified: false,
			uploaded: false,
			error: null,
		}
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true })
			const spec = DATASET_SPECS[dataset]
			const check = await this.duckdb.withConnection(
				async (connection) => {
					await connection.run(stagingDdl(dataset, "stage"))
					await DuckDBService.append(
						connection,
						"stage",
						this.repository.rows(dataset, bindingId, from, from + 86400),
					)
					await connection.run(
						`COPY (SELECT ${spec.projection} FROM stage ORDER BY ${spec.orderBy})
						 TO ${sqlString(tmp)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 500000)`,
					)
					const read = await DuckDBService.query(
						connection,
						`SELECT count(*)::BIGINT AS n,
						        epoch(min(${spec.dateColumn}))::BIGINT AS lo,
						        epoch(max(${spec.dateColumn}))::BIGINT AS hi
						 FROM read_parquet(${sqlString(tmp)})`,
					)
					return read.rows[0] ?? [0, null, null]
				},
				{ timeoutMs: null },
			)
			const [rows, lo, hi] = check as [number, number | null, number | null]
			result.rows = rows
			if (rows !== expected.rows || lo !== expected.min || hi !== expected.max)
				throw new Error(
					`verification failed: parquet ${rows} rows [${lo}, ${hi}], ` +
						`sqlite ${expected.rows} rows [${expected.min}, ${expected.max}]`,
				)
			result.sha256 = await sha256(tmp)
			result.bytes = fs.statSync(tmp).size
			fs.renameSync(tmp, file)
			result.verified = true
			this.repository.upsertManifest({
				binding_id: bindingId,
				date,
				dataset,
				rows,
				bytes: result.bytes,
				sha256: result.sha256,
				path: partitionKey(bindingId, date, dataset),
				exported_at: nowS(),
				verified_at: nowS(),
			})
		} catch (error) {
			result.error = (error as Error).message
			this.repository.upsertManifest({
				binding_id: bindingId,
				date,
				dataset,
				rows: result.rows,
				bytes: 0,
				sha256: "",
				path: partitionKey(bindingId, date, dataset),
				exported_at: nowS(),
				verified_at: null,
			})
			return result
		}
		result.uploaded = await this.upload(bindingId, date, dataset, file, result.bytes)
		return result
	}

	/** Uploads a verified partition and stamps uploaded_at after a HEAD size check. */
	private async upload(
		bindingId: number,
		date: string,
		dataset: Dataset,
		file: string,
		bytes: number,
	): Promise<boolean> {
		if (this.uploader.kind === "none") return false
		const key = partitionKey(bindingId, date, dataset)
		try {
			await this.uploader.put(key, file)
			const size = await this.uploader.head(key)
			if (size !== bytes) throw new Error(`HEAD size ${size} != ${bytes}`)
			this.repository.markUploaded(bindingId, date, dataset, nowS())
			return true
		} catch (error) {
			this.logger.warn(`upload ${key} failed: ${(error as Error).message}`)
			return false
		}
	}

	/**
	 * The nightly job: export the previous UTC date and every earlier hot date that has data
	 * but no verified archive (missed or failed nights), retry pending uploads, prune local
	 * partitions past ARCHIVE_LOCAL_DAYS that are safely uploaded.
	 */
	runNightly(now = nowS()): Promise<NightlyRun> {
		this.nightly ??= this.nightlyRun(now).finally(() => {
			this.nightly = undefined
		})
		return this.nightly
	}

	private async nightlyRun(now: number): Promise<NightlyRun> {
		const started = nowS()
		// The previous UTC date is complete once every late poll of it is written.
		const lastDate = utcDate(now - 86400 - SLACK_S)
		const firstDate = utcDate(now - (this.config.transit.hotDays + 1) * 86400)
		const verified = new Set(
			this.repository.verifiedDays().map((d) => `${d.binding_id}:${d.date}`),
		)
		let days = 0
		let failures = 0
		for (let day = utcDayStart(firstDate); day <= utcDayStart(lastDate); day += 86400) {
			const date = utcDate(day)
			for (const bindingId of this.repository.bindingsWithData(day, day + 86400)) {
				if (verified.has(`${bindingId}:${date}`)) continue
				try {
					const result = await this.exportDay(bindingId, date)
					if (!result.skipped) days++
					if (result.datasets.some((d) => d.error)) failures++
				} catch (error) {
					failures++
					this.logger.error(`export ${bindingId}:${date}: ${(error as Error).message}`)
				}
			}
		}
		let uploadsRetried = 0
		if (this.uploader.kind !== "none") {
			for (const row of this.repository.pendingUploads()) {
				const file = partitionFile(this.root, row.binding_id, row.date, row.dataset)
				if (!fs.existsSync(file)) continue
				if (await this.upload(row.binding_id, row.date, row.dataset, file, row.bytes))
					uploadsRetried++
			}
		}
		const pruned = this.prune(now)
		this.failedNights = failures ? this.failedNights + 1 : 0
		if (this.failedNights >= 2)
			this.logger.error(`archive export failed ${this.failedNights} nights in a row`)
		const run = {
			started_at: started,
			finished_at: nowS(),
			days,
			failures,
			uploads_retried: uploadsRetried,
			pruned,
		}
		this.lastRun = run
		this.logger.log(
			`nightly export: ${days} days, ${failures} failures, ${uploadsRetried} uploads retried, ${pruned} pruned`,
		)
		return run
	}

	/** Removes local partitions older than ARCHIVE_LOCAL_DAYS whose datasets are all uploaded. */
	prune(now = nowS()): number {
		if (this.uploader.kind === "none") return 0
		const before = utcDate(now - this.config.analytics.localDays * 86400)
		let pruned = 0
		for (const day of this.repository.uploadedDays(before)) {
			const dir = path.dirname(
				partitionFile(this.root, day.binding_id, day.date, "positions"),
			)
			if (!fs.existsSync(dir)) continue
			fs.rmSync(dir, { recursive: true, force: true })
			pruned++
		}
		return pruned
	}
}

function nowS(): number {
	return Math.floor(Date.now() / 1000)
}

async function sha256(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256")
	for await (const chunk of fs.createReadStream(file)) hasher.update(chunk as Buffer)
	return hasher.digest("hex")
}
