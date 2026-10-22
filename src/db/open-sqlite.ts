// open-sqlite.ts
// Opens a SQLite file with the PRAGMAs every database in this service uses (plan section 5).

import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

export function openSqlite(file: string): Database {
	if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })
	const sqlite = new Database(file, { create: true, strict: true })
	sqlite.exec("PRAGMA journal_mode = WAL")
	sqlite.exec("PRAGMA synchronous = NORMAL")
	sqlite.exec("PRAGMA busy_timeout = 5000")
	sqlite.exec("PRAGMA foreign_keys = ON")
	sqlite.exec("PRAGMA temp_store = MEMORY")
	return sqlite
}
