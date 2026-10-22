// open-sqlite.ts
// Opens a SQLite file with the PRAGMAs every database in this service uses (plan section 5).

import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

export interface OpenSqliteOptions {
	/** Open read-only (the tracker worker reads core.db and transit.db this way). */
	readonly?: boolean
	/** Set auto_vacuum=INCREMENTAL on a new file (vts.db, plan 8.7). */
	incrementalVacuum?: boolean
}

export function openSqlite(file: string, options: OpenSqliteOptions = {}): Database {
	if (options.readonly) {
		const sqlite = new Database(file, { readonly: true, strict: true })
		sqlite.exec("PRAGMA busy_timeout = 5000")
		sqlite.exec("PRAGMA temp_store = MEMORY")
		return sqlite
	}
	if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })
	const sqlite = new Database(file, { create: true, strict: true })
	// Only takes effect before the first table exists.
	if (options.incrementalVacuum) sqlite.exec("PRAGMA auto_vacuum = INCREMENTAL")
	sqlite.exec("PRAGMA journal_mode = WAL")
	sqlite.exec("PRAGMA synchronous = NORMAL")
	sqlite.exec("PRAGMA busy_timeout = 5000")
	sqlite.exec("PRAGMA foreign_keys = ON")
	sqlite.exec("PRAGMA temp_store = MEMORY")
	return sqlite
}
