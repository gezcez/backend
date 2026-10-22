// database.module.ts
// Global module that opens core.db, applies migrations at boot and provides the drizzle handle.
// transit.db and vts.db join here in P3 with the same pattern.

import type { Database } from "bun:sqlite"
import {
	Global,
	Inject,
	Injectable,
	Logger,
	Module,
	type OnApplicationShutdown,
} from "@nestjs/common"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import path from "node:path"
import { InjectConfig, type AppConfig } from "@common/config"
import * as coreSchema from "@schemas/core"
import { runMigrations } from "./migrate"
import { openSqlite } from "./open-sqlite"

export type CoreSchema = typeof coreSchema
export type CoreDatabase = BunSQLiteDatabase<CoreSchema> & { $client: Database }

export const CORE_DB = Symbol("CORE_DB")
export const InjectCoreDb = () => Inject(CORE_DB)

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
	readonly handles: DatabaseHandle[] = []

	constructor(@InjectConfig() private readonly config: AppConfig) {
		const file = path.join(config.dataDir, "core.db")
		const sqlite = openSqlite(file)
		const result = runMigrations(
			sqlite,
			path.join(config.migrationsDir, "core"),
			config.dataDir,
		)
		this.logger.log(
			`core.db ready (${result.applied} applied, ${result.total} total migrations)`,
		)
		this.core = drizzle({ client: sqlite, schema: coreSchema })
		this.handles.push({ name: "core", file, sqlite, migrated: true })
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
				handle.sqlite.close()
			} catch {
				// already closed
			}
		}
	}
}

@Global()
@Module({
	providers: [
		DatabaseService,
		{
			provide: CORE_DB,
			useFactory: (database: DatabaseService) => database.core,
			inject: [DatabaseService],
		},
	],
	exports: [DatabaseService, CORE_DB],
})
export class DatabaseModule {}
