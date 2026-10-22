// migrate.ts
// Runs the drizzle migrations of one database at boot, guarded by a lock file so two processes
// (API and tracker) starting together do not race.

import type { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import fs from "node:fs"
import path from "node:path"

const LOCK_STALE_MS = 120_000
const LOCK_WAIT_MS = 30_000

function acquireLock(lockPath: string): number {
	const started = Date.now()
	for (;;) {
		try {
			const fd = fs.openSync(lockPath, "wx")
			fs.writeSync(fd, String(process.pid))
			return fd
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			const stat = fs.statSync(lockPath, { throwIfNoEntry: false })
			if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
				fs.rmSync(lockPath, { force: true })
				continue
			}
			if (Date.now() - started > LOCK_WAIT_MS) {
				throw new Error(`Timed out waiting for migration lock ${lockPath}`)
			}
			Bun.sleepSync(100)
		}
	}
}

export interface MigrationResult {
	applied: number
	total: number
}

/** Applies every pending migration in `folder` to `sqlite`. */
export function runMigrations(sqlite: Database, folder: string, lockDir: string): MigrationResult {
	const journalPath = path.join(folder, "meta", "_journal.json")
	if (!fs.existsSync(journalPath)) throw new Error(`Missing migration journal ${journalPath}`)
	const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: unknown[] }

	fs.mkdirSync(lockDir, { recursive: true })
	const lockPath = path.join(lockDir, `.${path.basename(folder)}.migrate.lock`)
	const fd = acquireLock(lockPath)
	try {
		const countApplied = () => {
			const row = sqlite
				.query<{ n: number }, []>(
					"SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
				)
				.get()
			if (!row?.n) return 0
			return (
				sqlite
					.query<{ n: number }, []>("SELECT count(*) AS n FROM __drizzle_migrations")
					.get()?.n ?? 0
			)
		}
		const before = countApplied()
		migrate(drizzle({ client: sqlite }), { migrationsFolder: folder })
		const after = countApplied()
		return { applied: after - before, total: journal.entries.length }
	} finally {
		fs.closeSync(fd)
		fs.rmSync(lockPath, { force: true })
	}
}
