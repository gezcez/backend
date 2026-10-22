// database.module.ts
// Global module that opens core.db, transit.db and vts.db, applies migrations at boot and
// provides the drizzle handles. The tracker worker opens core.db and transit.db read-only and is
// the only writer of vts.db (plan 3.1 single-writer rule).

import type { Database } from "bun:sqlite"
import {
	Global,
	Inject,
	Injectable,
	Logger,
	Module,
	Optional,
	type DynamicModule,
	type OnApplicationShutdown,
} from "@nestjs/common"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import path from "node:path"
import { InjectConfig, type AppConfig } from "@common/config"
import * as coreSchema from "@schemas/core"
import * as transitSchema from "@schemas/transit"
import * as vtsSchema from "@schemas/vts"
import { runMigrations } from "./migrate"
import { openSqlite } from "./open-sqlite"
import { runSeed } from "./seed"

export type CoreSchema = typeof coreSchema
export type CoreDatabase = BunSQLiteDatabase<CoreSchema> & { $client: Database }
export type TransitSchema = typeof transitSchema
export type TransitDatabase = BunSQLiteDatabase<TransitSchema> & { $client: Database }
export type VtsSchema = typeof vtsSchema
export type VtsDatabase = BunSQLiteDatabase<VtsSchema> & { $client: Database }

export const CORE_DB = Symbol("CORE_DB")
export const TRANSIT_DB = Symbol("TRANSIT_DB")
export const VTS_DB = Symbol("VTS_DB")
export const DATABASE_OPTIONS = Symbol("DATABASE_OPTIONS")
export const InjectCoreDb = () => Inject(CORE_DB)
export const InjectTransitDb = () => Inject(TRANSIT_DB)
export const InjectVtsDb = () => Inject(VTS_DB)

/** rw: open, migrate and write. ro: open read-only, no migrations. */
export type DatabaseAccess = "rw" | "ro"

export interface DatabaseOptions {
	core: DatabaseAccess
	transit: DatabaseAccess
	vts: DatabaseAccess
	/** Seed the test fixtures when NODE_ENV=test (only the process that owns core.db). */
	seed: boolean
}

export const API_DATABASE_OPTIONS: DatabaseOptions = {
	core: "rw",
	transit: "rw",
	vts: "rw",
	seed: true,
}

export interface DatabaseHandle {
	name: string
	file: string
	sqlite: Database
	migrated: boolean
}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
	private readonly logger = new Logger("Database")
	readonly core: CoreDatabase
	readonly transit: TransitDatabase
	readonly vts: VtsDatabase
	readonly handles: DatabaseHandle[] = []

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		@Optional() @Inject(DATABASE_OPTIONS) options?: DatabaseOptions,
	) {
		const opts = options ?? API_DATABASE_OPTIONS
		this.core = drizzle({ client: this.open("core", opts.core), schema: coreSchema })
		this.transit = drizzle({
			client: this.open("transit", opts.transit),
			schema: transitSchema,
		})
		this.vts = drizzle({ client: this.open("vts", opts.vts), schema: vtsSchema })
		// The test image seeds itself so client repos' e2e suites get the e2e clients and fixtures.
		if (config.isTest && opts.seed && opts.core === "rw")
			runSeed(this.core, { environment: "test", config })
	}

	private open(name: "core" | "transit" | "vts", access: DatabaseAccess): Database {
		const file = path.join(this.config.dataDir, `${name}.db`)
		if (access === "ro") {
			const sqlite = openSqlite(file, { readonly: true })
			this.handles.push({ name, file, sqlite, migrated: true })
			return sqlite
		}
		const sqlite = openSqlite(file, { incrementalVacuum: name === "vts" })
		const result = runMigrations(
			sqlite,
			path.join(this.config.migrationsDir, name),
			this.config.dataDir,
		)
		this.logger.log(
			`${name}.db ready (${result.applied} applied, ${result.total} total migrations)`,
		)
		this.handles.push({ name, file, sqlite, migrated: true })
		return sqlite
	}

	/** Cheap liveness query per database for /ready. */
	check(): { name: string; ok: boolean }[] {
		return this.handles.map((handle) => {
			try {
				handle.sqlite.query("SELECT 1").get()
				return { name: handle.name, ok: handle.migrated }
			} catch {
				return { name: handle.name, ok: false }
			}
		})
	}

	onApplicationShutdown(): void {
		for (const handle of this.handles) {
			try {
				handle.sqlite.exec("PRAGMA optimize")
			} catch {
				// read-only or already closed
			}
			try {
				handle.sqlite.close()
			} catch {
				// already closed
			}
		}
	}
}

const handleProviders = [
	{
		provide: CORE_DB,
		useFactory: (database: DatabaseService) => database.core,
		inject: [DatabaseService],
	},
	{
		provide: TRANSIT_DB,
		useFactory: (database: DatabaseService) => database.transit,
		inject: [DatabaseService],
	},
	{
		provide: VTS_DB,
		useFactory: (database: DatabaseService) => database.vts,
		inject: [DatabaseService],
	},
]

@Global()
@Module({
	providers: [DatabaseService, ...handleProviders],
	exports: [DatabaseService, CORE_DB, TRANSIT_DB, VTS_DB],
})
export class DatabaseModule {
	/** Same module with explicit access modes (tracker worker and MODE=tracker). */
	static withOptions(options: DatabaseOptions): DynamicModule {
		return {
			module: DatabaseModule,
			global: true,
			providers: [
				{ provide: DATABASE_OPTIONS, useValue: options },
				DatabaseService,
				...handleProviders,
			],
			exports: [DatabaseService, CORE_DB, TRANSIT_DB, VTS_DB],
		}
	}
}
