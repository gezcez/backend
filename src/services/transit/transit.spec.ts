import { afterEach, describe, expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openSqlite, runMigrations, type TransitDatabase } from "@db"
import * as transitSchema from "@schemas/transit"
import { FakeProvider } from "@services/providers/fake/fake.provider"
import type { BindingContext, StaticChunk } from "@services/providers/transit-provider.interface"
import { validateBundle } from "./transit-sync.service"
import { TransitRepository, type StaticBundle } from "./transit.repository"

const MIGRATIONS = path.resolve(import.meta.dir, "../../../drizzle/transit")
const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function repository(): { repo: TransitRepository; db: TransitDatabase } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-transit-"))
	dirs.push(dir)
	const sqlite = openSqlite(path.join(dir, "transit.db"))
	runMigrations(sqlite, MIGRATIONS, dir)
	const db = drizzle({ client: sqlite, schema: transitSchema }) as TransitDatabase
	return { repo: new TransitRepository(db), db }
}

const BINDING: BindingContext = {
	id: 7,
	networkId: 1,
	providerKey: "fake",
	externalRef: "x",
	config: {},
	bbox: null,
	timezone: "Europe/Istanbul",
}

async function fakeBundle(): Promise<StaticBundle> {
	const bundle: StaticBundle = {
		agencies: [],
		routes: [],
		stops: [],
		patterns: [],
		services: [],
		trips: [],
	}
	for await (const chunk of new FakeProvider().fetchStatic(BINDING) as AsyncIterable<StaticChunk>)
		if (chunk.kind !== "warning") (bundle[chunk.kind] as unknown[]).push(...chunk.items)
	return bundle
}

describe("validateBundle", () => {
	test("drops dangling references with warnings", async () => {
		const bundle = await fakeBundle()
		bundle.patterns.push({
			externalId: "ghost",
			routeExternalId: "nope",
			direction: 0,
			headsign: "",
			shape: [],
			stops: [],
		})
		bundle.trips.push({
			externalId: "t",
			patternExternalId: "ghost",
			serviceExternalId: "1",
			startTimeS: 0,
		})
		bundle.stops.push({ externalId: "zero", name: "Zero", lat: 0, lon: 0 })
		const { bundle: valid, warnings } = validateBundle(bundle)
		expect(valid.patterns.some((p) => p.externalId === "ghost")).toBe(false)
		expect(valid.stops.some((s) => s.externalId === "zero")).toBe(false)
		expect(warnings.some((w) => w.includes("unknown route"))).toBe(true)
		expect(warnings.some((w) => w.includes("1 trips"))).toBe(true)
	})

	test("refuses a bundle without routes", () => {
		expect(() =>
			validateBundle({
				agencies: [],
				routes: [],
				stops: [],
				patterns: [],
				services: [],
				trips: [],
			}),
		).toThrow("no routes")
	})
})

describe("versioned swap", () => {
	test("activates atomically and keeps only the previous version", async () => {
		const { repo, db } = repository()
		const bundle = validateBundle(await fakeBundle()).bundle
		const v1 = repo.writeVersion(7, bundle, "h1")
		// A version being built is invisible to readers.
		expect(repo.activeVersion(7)).toBeUndefined()
		repo.activate(7, v1, {})
		expect(repo.activeVersion(7)?.version_id).toBe(v1)

		const v2 = repo.writeVersion(7, bundle, "h2")
		repo.activate(7, v2, {})
		const v3 = repo.writeVersion(7, bundle, "h3")
		repo.activate(7, v3, {})
		expect(repo.activeVersion(7)).toMatchObject({ version_id: v3, source_hash: "h3" })
		const versions = db.select().from(transitSchema.feedVersionsTable).all()
		expect(versions.map((v) => [v.id, v.status])).toEqual([
			[v2, "superseded"],
			[v3, "active"],
		])
		const routeVersions = new Set(
			db
				.select()
				.from(transitSchema.routesTable)
				.all()
				.map((r) => r.version_id),
		)
		expect([...routeVersions].sort()).toEqual([v2, v3])
		expect(repo.search([v1], '"durak"*', 5)).toEqual([])
		expect(repo.search([v3], '"durak"*', 5).length).toBe(5)
	})

	test("a failed version leaves the active one untouched", async () => {
		const { repo, db } = repository()
		const bundle = validateBundle(await fakeBundle()).bundle
		const v1 = repo.writeVersion(7, bundle, "h1")
		repo.activate(7, v1, {})
		const v2 = repo.writeVersion(7, bundle, "h2")
		repo.failVersion(v2, "boom")
		expect(repo.activeVersion(7)?.version_id).toBe(v1)
		expect(
			db
				.select()
				.from(transitSchema.tripsTable)
				.all()
				.every((t) => t.version_id === v1),
		).toBe(true)
	})

	test("stores trips with times past midnight and pattern stop offsets", async () => {
		const { repo } = repository()
		const bundle = validateBundle(await fakeBundle()).bundle
		const v = repo.writeVersion(7, bundle, "h")
		repo.activate(7, v, {})
		const pattern = repo.patternByRoute(v, "9001", 0)!
		expect(pattern.stop_count).toBe(8)
		expect(pattern.length_m).toBeGreaterThan(1000)
		const stops = repo.patternStops([pattern.id])
		expect(stops.map((s) => s.offset_s)).toEqual([0, 120, 240, 360, 480, 600, 720, 840])
		expect(repo.countTrips(v)).toBe(bundle.trips.length)
	})
})
