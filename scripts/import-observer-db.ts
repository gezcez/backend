// import-observer-db.ts
// One-shot import of a kentkart-vts-observer VTS.db into the Parquet archive (plan 2.2).
//
//   bun scripts/import-observer-db.ts --db /path/to/VTS.db [--region 004 | --binding <id>]
//                                     [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--force]
//
// Uses DATA_DIR and the ARCHIVE_* settings like the server: Parquet under data/archive, rows
// in vts.db archive_manifest (and vehicles), uploads when ARCHIVE_UPLOAD is set. The Kentkart
// binding is found by its region (external_ref, default 004) unless --binding is given. Run it
// with the tracker stopped or idle; it is safe to re-run (verified days are skipped).

import { drizzle } from "drizzle-orm/bun-sqlite"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { loadConfig } from "@common/config"
import { openSqlite, runMigrations, type VtsDatabase } from "@db"
import * as vtsSchema from "@schemas/vts"
import { DuckDBService } from "@services/analytics/duckdb.service"
import { ArchiveRepository } from "@services/archive/archive.repository"
import { ArchiveService } from "@services/archive/archive.service"
import { createUploader } from "@services/archive/archive.uploader"
import { ObserverImport } from "@services/archive/observer-import"
import { ObserverRepository } from "@services/archive/observer.repository"

const { values } = parseArgs({
	options: {
		db: { type: "string" },
		region: { type: "string", default: "004" },
		binding: { type: "string" },
		from: { type: "string" },
		to: { type: "string" },
		force: { type: "boolean", default: false },
	},
})
if (!values.db) {
	console.error(
		"usage: bun scripts/import-observer-db.ts --db VTS.db [--region 004 | --binding id]",
	)
	process.exit(2)
}

const config = loadConfig()
let bindingId = values.binding ? Number(values.binding) : undefined
if (bindingId === undefined) {
	const coreFile = path.join(config.dataDir, "core.db")
	if (!fs.existsSync(coreFile)) {
		console.error(
			`${coreFile} not found; run the server or db:migrate first, or pass --binding`,
		)
		process.exit(1)
	}
	const core = openSqlite(coreFile, { readonly: true })
	const row = core
		.query<{ id: number }, [string]>(
			"SELECT id FROM provider_bindings WHERE provider_key = 'kentkart' AND external_ref = ?",
		)
		.get(values.region!)
	core.close()
	if (!row) {
		console.error(`No kentkart binding with region ${values.region}; pass --binding`)
		process.exit(1)
	}
	bindingId = row.id
}

const sqlite = openSqlite(path.join(config.dataDir, "vts.db"), { incrementalVacuum: true })
runMigrations(sqlite, path.join(config.migrationsDir, "vts"), config.dataDir)
const vts = drizzle({ client: sqlite, schema: vtsSchema }) as VtsDatabase
const duckdb = new DuckDBService(config)
const repository = new ArchiveRepository(vts)
const archive = new ArchiveService(config, repository, duckdb, createUploader(config.analytics))
const source = new ObserverRepository(path.resolve(values.db))
try {
	const report = await new ObserverImport(archive, repository).run(source, {
		bindingId,
		force: values.force,
		from: values.from,
		to: values.to,
		log: (line) => console.log(line),
	})
	const failed = report.days.filter((d) => d.datasets.some((x) => x.error))
	console.log(
		`binding ${bindingId}: read ${report.read}, kept ${report.kept}, duplicates ${report.duplicates}, ` +
			`staff ${report.staff}, test ${report.test}, invalid ${report.invalid}, runs ${report.runs}, ` +
			`days ${report.days.filter((d) => !d.skipped).length} archived, ` +
			`${report.days.filter((d) => d.skipped).length} skipped, ${failed.length} failed`,
	)
	if (failed.length) process.exitCode = 1
} finally {
	source.close()
	duckdb.onApplicationShutdown()
	sqlite.close()
}
