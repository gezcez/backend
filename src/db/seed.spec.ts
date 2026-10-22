import { afterEach, describe, expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "@common/config"
import * as coreSchema from "@schemas/core"
import type { CoreDatabase } from "./database.module"
import { runMigrations } from "./migrate"
import { openSqlite } from "./open-sqlite"
import { runSeed, seedApps, type SeedEnvironment } from "./seed"

const MIGRATIONS = path.resolve(import.meta.dir, "../../drizzle/core")
const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function freshDb(): CoreDatabase {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-seed-"))
	dirs.push(dir)
	const sqlite = openSqlite(path.join(dir, "core.db"))
	runMigrations(sqlite, MIGRATIONS, dir)
	return drizzle({ client: sqlite, schema: coreSchema }) as CoreDatabase
}

function seed(db: CoreDatabase, environment: SeedEnvironment, rootEmail?: string) {
	return runSeed(db, { environment, config: loadConfig({}), rootEmail })
}

describe("seed", () => {
	test("is idempotent", () => {
		const db = freshDb()
		seed(db, "test")
		const count = () => ({
			apps: db.select().from(coreSchema.appsTable).all().length,
			roles: db.select().from(coreSchema.rolesTable).all().length,
			grants: db.select().from(coreSchema.rolePermissionsTable).all().length,
			users: db.select().from(coreSchema.usersTable).all().length,
			userRoles: db.select().from(coreSchema.userRolesTable).all().length,
		})
		const first = count()
		seed(db, "test")
		expect(count()).toEqual(first)
	})

	test("production gets the system clients with production URIs only", () => {
		const apps = seedApps("production")
		expect(apps.map((app) => app.client_id)).toEqual(["dashboard", "mobile"])
		expect(apps[0]?.redirect_uris).toEqual([
			"https://dash.gezcez.com/auth/callback",
			"https://dash.gezcez.com/auth/step-up",
		])
		expect(apps[0]?.post_logout_redirect_uris).toEqual([
			"https://dash.gezcez.com/auth/logged-out",
		])
		expect(apps[0]?.refresh_cookie).toBe(true)
		expect(apps[1]?.redirect_uris).toEqual(["gezcez://oauth/callback"])
		expect(apps[1]?.refresh_ttl_s).toBe(7_776_000)
	})

	test("staging gets the preview scheme and the dev clients", () => {
		const apps = seedApps("staging")
		expect(apps.map((app) => app.client_id)).toEqual([
			"dashboard",
			"dashboard-dev",
			"mobile",
			"mobile-dev",
		])
		expect(apps.find((app) => app.client_id === "mobile")?.redirect_uris).toEqual([
			"gezcez-preview://oauth/callback",
		])
		expect(apps.find((app) => app.client_id === "dashboard")?.redirect_uris[0]).toBe(
			"https://dash-staging.gezcez.com/auth/callback",
		)
	})

	test("e2e clients exist only in test", () => {
		for (const env of ["production", "staging", "local"] as const) {
			expect(seedApps(env).some((app) => app.client_id.startsWith("e2e_"))).toBe(false)
		}
		expect(seedApps("test").filter((app) => app.client_id.startsWith("e2e_")).length).toBe(2)
	})

	test("default roles carry their grants and root holds none", () => {
		const db = freshDb()
		seed(db, "local", "Owner@Example.com")
		const roles = db.select().from(coreSchema.rolesTable).all()
		expect(roles.map((role) => [role.key, role.level])).toEqual([
			["root", 1000],
			["admin", 900],
			["network_admin", 500],
			["moderator", 300],
			["analyst", 200],
			["viewer", 100],
		])
		const grants = db.select().from(coreSchema.rolePermissionsTable).all()
		const keysOf = (key: string) => {
			const role = roles.find((r) => r.key === key)!
			return grants.filter((g) => g.role_id === role.id).map((g) => g.permission_key)
		}
		expect(keysOf("root")).toEqual([])
		expect(keysOf("admin")).not.toContain("permissions.write")
		expect(keysOf("admin")).not.toContain("providers.kill")
		expect(keysOf("viewer").sort()).toEqual([
			"analytics.read",
			"catalog.read",
			"network.overview.read",
		])
		const owner = db.select().from(coreSchema.usersTable).all()
		expect(owner.map((user) => user.email)).toEqual(["owner@example.com"])
	})

	test("editable roles keep dashboard edits on re-seed", () => {
		const db = freshDb()
		seed(db, "local")
		const viewer = db
			.select()
			.from(coreSchema.rolesTable)
			.all()
			.find((role) => role.key === "viewer")!
		db.delete(coreSchema.rolePermissionsTable).run()
		seed(db, "local")
		const grants = db.select().from(coreSchema.rolePermissionsTable).all()
		expect(grants.filter((g) => g.role_id === viewer.id)).toEqual([])
	})
})
