// seed.ts
// Idempotent seed per environment:
//   bun run db:seed [--env production|staging|local|test] [--root-email you@example.com]

import path from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { loadConfig } from "@common/config"
import { openSqlite, runMigrations, type CoreDatabase } from "@db"
import * as coreSchema from "@schemas/core"
import { runSeed, type SeedEnvironment } from "@db/seed"

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name)
	return index >= 0 ? process.argv[index + 1] : undefined
}

const config = loadConfig()
const fallback: SeedEnvironment =
	config.env === "production" || config.env === "staging" || config.env === "test"
		? config.env
		: "local"
const environment = (arg("--env") ?? fallback) as SeedEnvironment
if (!["production", "staging", "local", "test"].includes(environment)) {
	throw new Error(`Unknown --env ${environment}`)
}

const sqlite = openSqlite(path.join(config.dataDir, "core.db"))
runMigrations(sqlite, path.join(config.migrationsDir, "core"), config.dataDir)
const db = drizzle({ client: sqlite, schema: coreSchema }) as CoreDatabase
for (const line of runSeed(db, { environment, config, rootEmail: arg("--root-email") })) {
	console.log(`seed ${line}`)
}
console.log(`seed done (${environment})`)
sqlite.close()
