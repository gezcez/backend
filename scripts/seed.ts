// seed.ts
// Idempotent seed per environment: `bun run db:seed [--env production|staging|local|test]`.
// Every step upserts, so running it twice changes nothing. Steps are added as tables land.

import path from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { loadConfig } from "@common/config"
import { openSqlite, runMigrations, type CoreDatabase } from "@db"
import * as coreSchema from "@schemas/core"
import { SEED_STEPS, type SeedEnvironment } from "./seed.steps"

function parseEnvironment(argv: string[], fallback: SeedEnvironment): SeedEnvironment {
	const index = argv.indexOf("--env")
	const value = index >= 0 ? argv[index + 1] : undefined
	if (!value) return fallback
	if (!["production", "staging", "local", "test"].includes(value)) {
		throw new Error(`Unknown --env ${value}`)
	}
	return value as SeedEnvironment
}

const config = loadConfig()
const fallback: SeedEnvironment =
	config.env === "production"
		? "production"
		: config.env === "staging"
			? "staging"
			: config.env === "test"
				? "test"
				: "local"
const environment = parseEnvironment(process.argv, fallback)

const sqlite = openSqlite(path.join(config.dataDir, "core.db"))
runMigrations(sqlite, path.join(config.migrationsDir, "core"), config.dataDir)
const db = drizzle({ client: sqlite, schema: coreSchema }) as CoreDatabase

for (const step of SEED_STEPS) {
	const result = step.run(db, { environment, config })
	console.log(`seed ${step.name}: ${result}`)
}
console.log(`seed done (${environment}, ${SEED_STEPS.length} steps)`)
sqlite.close()
