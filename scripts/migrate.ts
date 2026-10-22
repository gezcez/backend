// migrate.ts
// Applies pending migrations of every database without starting the server (the server also
// migrates at boot).

import path from "node:path"
import { loadConfig } from "@common/config"
import { openSqlite, runMigrations } from "@db"

const config = loadConfig()
for (const name of ["core", "transit", "vts"] as const) {
	const sqlite = openSqlite(path.join(config.dataDir, `${name}.db`), {
		incrementalVacuum: name === "vts",
	})
	const result = runMigrations(sqlite, path.join(config.migrationsDir, name), config.dataDir)
	console.log(`${name}.db: ${result.applied} applied, ${result.total} total`)
	sqlite.close()
}
