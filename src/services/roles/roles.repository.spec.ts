import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestApp, type TestApp } from "@test/helpers/app"
import { RolesRepository, type RouteRecord } from "./roles.repository"

let t: TestApp
let repository: RolesRepository

beforeAll(async () => {
	t = await createTestApp()
	repository = t.app.get(RolesRepository)
})
afterAll(async () => {
	await t.close()
})

function route(method: string, path: string, partial: Partial<RouteRecord> = {}): RouteRecord {
	return {
		method,
		path,
		permission_key: "users.read",
		scope: "global",
		sudo: false,
		description: `${method} ${path}`,
		...partial,
	}
}

describe("RolesRepository registry", () => {
	test("the boot sync lists every permission key sorted, and the routes found in code", () => {
		const keys = repository.listPermissions().map((p) => p.key)
		expect(keys.length).toBeGreaterThan(10)
		expect(keys).toEqual([...keys].sort())
		expect(keys).toContain("users.read")
		const routes = repository.listRoutes()
		expect(routes.length).toBeGreaterThan(10)
		expect(routes.some((r) => r.path.startsWith("/v1/dash/users"))).toBe(true)
	})

	test("syncRoutes upserts changed routes and drops the ones no longer in code", () => {
		const now = new Date()
		repository.syncRoutes(
			[route("GET", "/v1/a"), route("POST", "/v1/a", { sudo: true }), route("GET", "/v1/b")],
			now,
		)
		expect(repository.listRoutes().map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /v1/a",
			"POST /v1/a",
			"GET /v1/b",
		])
		const before = repository.listRoutes().find((r) => r.method === "GET" && r.path === "/v1/a")!

		repository.syncRoutes(
			[route("GET", "/v1/a", { permission_key: "roles.read", description: "changed" })],
			now,
		)
		const after = repository.listRoutes()
		expect(after).toHaveLength(1)
		expect(after[0]).toMatchObject({
			id: before.id,
			method: "GET",
			path: "/v1/a",
			permission_key: "roles.read",
			scope: "global",
			sudo: false,
			description: "changed",
		})
	})
})
