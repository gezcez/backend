// duckdb.service.ts
// One in-process DuckDB instance per process (plan 6.9) on @duckdb/node-api, used by the archive
// export and the analytics queries. It sets threads and memory, loads the h3 extension when the
// image ships it and otherwise registers an h3-js scalar function with the same name, so SQL
// never branches. A queue runs at most ANALYTICS_MAX_CONCURRENT queries; each one gets its own
// connection (temp tables and macros are connection scoped) and a timeout via interrupt().
//
// SQLite is read through bun:sqlite and appended into DuckDB temp tables instead of the DuckDB
// sqlite extension: the extension needs a download or a preinstalled file, the appender path
// needs neither and behaves the same in tests, in the worker and in the image.

import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common"
import path from "node:path"
import type { DuckDBConnection, DuckDBInstance, JS } from "@duckdb/node-api"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"

export type H3Mode = "extension" | "js"

/** A value as it leaves DuckDB for JSON: numbers, strings, booleans or null. */
export type CellValue = number | string | boolean | null

export interface QueryResult {
	columns: string[]
	rows: CellValue[][]
}

type DuckDBApi = typeof import("@duckdb/node-api")

// The native module (about 60 MB) loads on the first query, not at boot.
let api: DuckDBApi | undefined
async function loadApi(): Promise<DuckDBApi> {
	api ??= await import("@duckdb/node-api")
	return api
}

/** Single-quoted SQL string literal. Inputs are validated by zod first; this is the escaper. */
export function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

function toCell(value: unknown): CellValue {
	if (value === null || value === undefined) return null
	if (typeof value === "bigint") return Number(value)
	if (typeof value === "number") return Number.isFinite(value) ? value : null
	if (typeof value === "string" || typeof value === "boolean") return value
	if (api && value instanceof api.DuckDBDecimalValue) return value.toDouble()
	return String(value)
}

const YIELD_EVERY = 20_000
/** Connections whose request timed out (the appender loop checks it). */
const timedOut = new WeakSet<DuckDBConnection>()

interface Waiter {
	resolve: () => void
}

@Injectable()
export class DuckDBService implements OnApplicationShutdown {
	private readonly logger = new Logger("DuckDB")
	private instance: Promise<DuckDBInstance> | undefined
	private h3: H3Mode = "js"
	private running = 0
	private readonly waiting: Waiter[] = []
	private readonly durations: number[] = []

	constructor(@InjectConfig() private readonly config: AppConfig) {}

	/** Which H3 implementation `gz_h3(lat, lon, res)` uses in this process. */
	get h3Mode(): H3Mode {
		return this.h3
	}

	private async open(): Promise<DuckDBInstance> {
		const { threads, memoryLimit, extensionDir } = this.config.analytics.duckdb
		const options: Record<string, string> = {
			threads: String(threads),
			memory_limit: memoryLimit,
			// Never reach the network at runtime: extensions come from the image or not at all.
			autoinstall_known_extensions: "false",
			// Spill next to the data (the image's root file system is read-only).
			temp_directory: path.join(this.config.dataDir, ".duckdb-tmp"),
		}
		if (extensionDir) options.extension_directory = extensionDir
		const { DuckDBInstance, DuckDBScalarFunction, DOUBLE, INTEGER, VARCHAR } = await loadApi()
		const instance = await DuckDBInstance.create(":memory:", options)
		const connection = await instance.connect()
		try {
			try {
				await connection.run("LOAD h3")
				await connection.run(
					"CREATE MACRO gz_h3(lat, lon, res) AS h3_h3_to_string(h3_latlng_to_cell(lat, lon, res))",
				)
				this.h3 = "extension"
			} catch {
				const { latLngToCell } = await import("h3-js")
				connection.registerScalarFunction(
					DuckDBScalarFunction.create({
						name: "gz_h3",
						returnType: VARCHAR,
						parameterTypes: [DOUBLE, DOUBLE, INTEGER],
						mainFunction: (_info, input, output) => {
							const lat = input.getColumnVector(0)
							const lon = input.getColumnVector(1)
							const res = input.getColumnVector(2)
							for (let i = 0; i < input.rowCount; i++) {
								const a = lat.getItem(i) as number | null
								const b = lon.getItem(i) as number | null
								const r = res.getItem(i) as number | null
								output.setItem(
									i,
									a === null || b === null || r === null
										? null
										: latLngToCell(a, b, r),
								)
							}
							output.flush()
						},
					}),
				)
				this.h3 = "js"
			}
		} finally {
			connection.closeSync()
		}
		this.logger.log(`DuckDB ready (threads ${threads}, memory ${memoryLimit}, h3 ${this.h3})`)
		return instance
	}

	private ready(): Promise<DuckDBInstance> {
		this.instance ??= this.open().catch((error: unknown) => {
			this.instance = undefined
			throw error
		})
		return this.instance
	}

	private async acquire(): Promise<void> {
		if (this.running < this.config.analytics.maxConcurrent) {
			this.running++
			return
		}
		await new Promise<void>((resolve) => this.waiting.push({ resolve }))
		this.running++
	}

	private release(): void {
		this.running--
		this.waiting.shift()?.resolve()
	}

	/**
	 * Runs `work` on a fresh connection (UTC session time zone) inside the queue. With a timeout,
	 * the connection is interrupted when it expires and the call fails with ANALYTICS_TIMEOUT.
	 */
	async withConnection<T>(
		work: (connection: DuckDBConnection) => Promise<T>,
		options: { timeoutMs?: number | null } = {},
	): Promise<T> {
		const instance = await this.ready()
		await this.acquire()
		const started = performance.now()
		const connection = await instance.connect()
		let expired = false
		const timeoutMs =
			options.timeoutMs === undefined ? this.config.analytics.timeoutMs : options.timeoutMs
		const timer =
			timeoutMs === null
				? undefined
				: setTimeout(() => {
						expired = true
						timedOut.add(connection)
						connection.interrupt()
					}, timeoutMs)
		try {
			await connection.run("SET TimeZone = 'UTC'")
			return await work(connection)
		} catch (error) {
			if (expired) throw new GezcezError("ANALYTICS_TIMEOUT")
			throw error
		} finally {
			if (timer) clearTimeout(timer)
			connection.closeSync()
			this.record(performance.now() - started)
			this.release()
		}
	}

	private record(ms: number): void {
		this.durations.push(ms)
		if (this.durations.length > 200) this.durations.shift()
	}

	/** p95 of the last 200 query durations in ms (system health). */
	p95Ms(): number | null {
		if (!this.durations.length) return null
		const sorted = [...this.durations].sort((a, b) => a - b)
		return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!)
	}

	/** Runs a statement and returns its rows as JSON-safe values. */
	static async query(connection: DuckDBConnection, sql: string): Promise<QueryResult> {
		const reader = await connection.runAndReadAll(sql)
		return {
			columns: reader.columnNames(),
			rows: reader.getRows().map((row) => row.map(toCell)),
		}
	}

	/** Appends JS rows (in column order) to an existing table through the appender. */
	static async append(
		connection: DuckDBConnection,
		table: string,
		rows: Iterable<readonly unknown[]>,
	): Promise<number> {
		const { DuckDBDataChunkWriter, JSToDuckDBValueConverter } = await loadApi()
		const appender = await connection.createAppender(table)
		const writer = DuckDBDataChunkWriter.forAppender(appender, {
			converter: JSToDuckDBValueConverter,
		})
		let count = 0
		try {
			for (const row of rows) {
				writer.appendRow(row as readonly JS[])
				// Large hot loads give the event loop (HTTP, timers) a turn now and then, and
				// stop once the request timed out.
				if (++count % YIELD_EVERY === 0) {
					await new Promise((resolve) => setImmediate(resolve))
					if (timedOut.has(connection)) throw new GezcezError("ANALYTICS_TIMEOUT")
				}
			}
			writer.flush()
			appender.flushSync()
		} finally {
			appender.closeSync()
		}
		return count
	}

	onApplicationShutdown(): void {
		void this.instance
			?.then((instance) => instance.closeSync())
			.catch(() => {
				// never opened
			})
	}
}
