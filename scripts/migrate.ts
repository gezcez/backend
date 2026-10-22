// migrate.ts
// Applies pending migrations without starting the server (the server also migrates at boot).

import path from "node:path"
import { loadConfig } from "@common/config"
import { openSqlite, runMigrations } from "@db"

const config = loadConfig()
const sqlite = openSqlite(path.join(config.dataDir, "core.db"))
const result = runMigrations(sqlite, path.join(config.migrationsDir, "core"), config.dataDir)
console.log(`core.db: ${result.applied} applied, ${result.total} total`)
sqlite.close()
