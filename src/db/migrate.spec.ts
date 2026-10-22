import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runMigrations } from "./migrate"
import { openSqlite } from "./open-sqlite"

const dirs: string[] = []
function tempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-migrate-"))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function writeMigration(folder: string, tag: string, sql: string, index: number) {
	fs.mkdirSync(path.join(folder, "meta"), { recursive: true })
	fs.writeFileSync(path.join(folder, `${tag}.sql`), sql)
	const journalPath = path.join(folder, "meta", "_journal.json")
	const journal = fs.existsSync(journalPath)
		? JSON.parse(fs.readFileSync(journalPath, "utf8"))
		: { version: "7", dialect: "sqlite", entries: [] }
	journal.entries.push({
		idx: index,
		version: "6",
		when: 1700000000000 + index,
		tag,
		breakpoints: true,
	})
	fs.writeFileSync(journalPath, JSON.stringify(journal))
}

describe("openSqlite", () => {
	test("enables WAL and foreign keys", () => {
		const dir = tempDir()
		const db = openSqlite(path.join(dir, "x.db"))
		expect(
			db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
		).toBe("wal")
		expect(
			db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys,
		).toBe(1)
		db.close()
	})
})

describe("runMigrations", () => {
	test("applies pending migrations once and removes its lock", () => {
		const dir = tempDir()
		const folder = path.join(dir, "migrations", "core")
		writeMigration(folder, "0000_init", "CREATE TABLE a (id integer primary key);", 0)
		const db = openSqlite(path.join(dir, "core.db"))

		expect(runMigrations(db, folder, dir)).toEqual({ applied: 1, total: 1 })
		expect(runMigrations(db, folder, dir)).toEqual({ applied: 0, total: 1 })

		writeMigration(folder, "0001_more", "CREATE TABLE b (id integer primary key);", 1)
		expect(runMigrations(db, folder, dir)).toEqual({ applied: 1, total: 2 })
		expect(fs.readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false)
		db.close()
	})

	test("fails fast when the journal is missing", () => {
		const dir = tempDir()
		const db = openSqlite(path.join(dir, "core.db"))
		expect(() => runMigrations(db, path.join(dir, "nope"), dir)).toThrow(
			"Missing migration journal",
		)
		db.close()
	})
})
