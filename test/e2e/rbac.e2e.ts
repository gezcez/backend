import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq, like } from "drizzle-orm"
import type { Request } from "express"
import { DatabaseService } from "@db"
import { auditLogTable, networksTable, permissionsTable, usersTable } from "@schemas/core"
import { PermissionCacheService } from "@services/roles/permission-cache.service"
import { PermissionRegistryService } from "@services/roles/permission-registry.service"
import { RolesService } from "@services/roles/roles.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { accessTokenFor } from "../helpers/oauth-client"

let t: TestApp

beforeAll(async () => {
	t = await createTestApp()
})
afterAll(async () => {
	await t.close()
})

const db = () => t.app.get(DatabaseService).core

function userId(email: string): number {
	return db().select().from(usersTable).where(eq(usersTable.email, email)).get()!.id
}

function networkId(slug: string): number {
	return db().select().from(networksTable).where(eq(networksTable.slug, slug)).get()!.id
}

async function api<T = unknown>(path: string, token?: string, init: RequestInit = {}) {
	return t.json<{
		ok: boolean
		data: T
		error: { code: string; details?: Record<string, unknown> }
	}>(path, {
		...init,
		headers: {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(init.body ? { "content-type": "application/json" } : {}),
			...init.headers,
		},
	})
}

describe("bearer authentication", () => {
	test("routes are bearer-protected by default", async () => {
		const none = await api("/v1/me")
		expect(none.status).toBe(401)
		expect(none.body.error.code).toBe("AUTH_REQUIRED")
		const garbage = await api("/v1/me", "not.a.jwt")
		expect(garbage.body.error.code).toBe("AUTH_TOKEN_INVALID")
		const basic = await api("/v1/me", undefined, { headers: { authorization: "Basic eDp5" } })
		expect(basic.body.error.code).toBe("AUTH_TOKEN_INVALID")
	})

	test("a tampered token is refused", async () => {
		const { accessToken } = await accessTokenFor(t, "rider@test.gezcez.com")
		const [header, payload, signature] = accessToken.split(".")
		const forged = JSON.parse(Buffer.from(payload!, "base64url").toString())
		forged.sub = "01AAAAAAAAAAAAAAAAAAAAAAAA"
		const tampered = `${header}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`
		const res = await api("/v1/me", tampered)
		expect(res.body.error.code).toBe("AUTH_TOKEN_INVALID")
	})

	test("tokens of a signed-out session stop working at once", async () => {
		const { accessToken, browser } = await accessTokenFor(t, "rider@test.gezcez.com")
		expect((await api("/v1/me", accessToken)).status).toBe(200)
		await browser.post("/v1/oauth/logout", { scope: "session" })
		const res = await api("/v1/me", accessToken)
		expect(res.status).toBe(401)
		expect(res.body.error.code).toBe("AUTH_SESSION_REVOKED")
	})
})

describe("GET and PATCH /v1/me", () => {
	test("a network admin sees the network entry with effective permissions", async () => {
		const { accessToken } = await accessTokenFor(t, "netadmin@test.gezcez.com")
		const me = await api<{
			user: { display_name: string; email_masked: string; username: string | null }
			auth_time: number
			amr: string[]
			global: { roles: unknown[]; permissions: string[] }
			networks: {
				slug: string
				city: { slug: string; name: string }
				roles: { key: string; level: number }[]
				permissions: string[]
			}[]
		}>("/v1/me", accessToken)
		expect(me.status).toBe(200)
		expect(me.body.data.user).toMatchObject({
			display_name: "Network Admin Fixture",
			email_masked: "n***@test.gezcez.com",
			username: null,
		})
		expect(me.body.data.amr).toEqual(["otp"])
		expect(Math.abs(Date.now() / 1000 - me.body.data.auth_time)).toBeLessThan(10)
		expect(me.body.data.global).toEqual({ roles: [], permissions: [] })
		expect(me.body.data.networks).toHaveLength(1)
		const network = me.body.data.networks[0]!
		expect(network).toMatchObject({
			slug: "kocaeli-ulasimpark",
			city: { slug: "kocaeli", name: "Kocaeli" },
			roles: [{ key: "network_admin", level: 500 }],
		})
		expect(network.permissions).toContain("members.roles.write")
		expect(network.permissions).toContain("tracker.control")
		expect(network.permissions).not.toContain("users.read")
	})

	test("global roles list global permissions and add no network entries; root holds all", async () => {
		const admin = await accessTokenFor(t, "admin@test.gezcez.com")
		const me = await api<{
			global: { roles: { key: string }[]; permissions: string[] }
			networks: unknown[]
		}>("/v1/me", admin.accessToken)
		expect(me.body.data.global.roles.map((role) => role.key)).toEqual(["admin"])
		expect(me.body.data.global.permissions).toContain("roles.assign")
		expect(me.body.data.global.permissions).not.toContain("providers.kill")
		expect(me.body.data.networks).toEqual([])

		const root = await accessTokenFor(t, "root@test.gezcez.com")
		const rootMe = await api<{ global: { permissions: string[] } }>("/v1/me", root.accessToken)
		expect(rootMe.body.data.global.permissions).toContain("providers.kill")
		expect(rootMe.body.data.global.permissions).toContain("permissions.write")
	})

	test("PATCH /v1/me needs the profile scope", async () => {
		const withProfile = await accessTokenFor(t, "rider@test.gezcez.com", {
			clientId: "e2e_client",
			scope: "openid profile",
		})
		const patched = await api<{ user: { display_name: string; locale: string } }>(
			"/v1/me",
			withProfile.accessToken,
			{
				method: "PATCH",
				body: JSON.stringify({ display_name: "Rider Renamed", locale: "tr" }),
			},
		)
		expect(patched.status).toBe(200)
		expect(patched.body.data.user).toMatchObject({
			display_name: "Rider Renamed",
			locale: "tr",
		})

		const empty = await api("/v1/me", withProfile.accessToken, {
			method: "PATCH",
			body: JSON.stringify({}),
		})
		expect(empty.body.error.code).toBe("VALIDATION_FAILED")

		const openidOnly = await accessTokenFor(t, "rider@test.gezcez.com", {
			clientId: "e2e_client",
			scope: "openid",
		})
		const denied = await api("/v1/me", openidOnly.accessToken, {
			method: "PATCH",
			body: JSON.stringify({ locale: "en" }),
		})
		expect(denied.status).toBe(403)
		expect(denied.body.error).toMatchObject({
			code: "SCOPE_MISSING",
			details: { required: ["profile"] },
		})
		// Reading /v1/me needs no particular scope.
		expect((await api("/v1/me", openidOnly.accessToken)).status).toBe(200)
	})
})

describe("@UseAuthorization", () => {
	test("dashboard routes need the dash scope and the permission", async () => {
		const admin = await accessTokenFor(t, "admin@test.gezcez.com")
		const list = await api<{
			keys: { key: string; orphaned: boolean }[]
			routes: { method: string; path: string; permission_key: string }[]
		}>("/v1/dash/permissions", admin.accessToken)
		expect(list.status).toBe(200)
		expect(list.body.data.keys.map((key) => key.key)).toContain("tracker.control")
		expect(list.body.data.routes).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: "/v1/dash/permissions",
				permission_key: "permissions.read",
			}),
		)

		const moderator = await accessTokenFor(t, "moderator@test.gezcez.com")
		const missing = await api("/v1/dash/permissions", moderator.accessToken)
		expect(missing.status).toBe(403)
		expect(missing.body.error).toMatchObject({
			code: "PERMISSION_MISSING",
			details: { permission: "permissions.read", scope: "global" },
		})

		const noDash = await accessTokenFor(t, "admin@test.gezcez.com", { scope: "openid profile" })
		const scope = await api("/v1/dash/permissions", noDash.accessToken)
		expect(scope.body.error.code).toBe("SCOPE_MISSING")

		const root = await accessTokenFor(t, "root@test.gezcez.com")
		expect((await api("/v1/dash/permissions", root.accessToken)).status).toBe(200)
	})

	test("the registry stored the guarded routes and marked unknown keys orphaned", async () => {
		const registry = t.app.get(PermissionRegistryService)
		expect(registry.registered().map((route) => `${route.method} ${route.path}`)).toContain(
			"GET /v1/dash/permissions",
		)
		db()
			.insert(permissionsTable)
			.values({
				key: "legacy.key",
				scope: "global",
				description: "old",
				first_seen_at: new Date(0),
			})
			.run()
		registry.onApplicationBootstrap()
		const row = db()
			.select()
			.from(permissionsTable)
			.where(eq(permissionsTable.key, "legacy.key"))
			.get()
		expect(row?.orphaned_at).toBeInstanceOf(Date)
	})

	test("the OpenAPI document carries x-gezcez-permission and the PermissionKey enum", async () => {
		const doc = await t.json<{
			paths: Record<string, Record<string, Record<string, unknown>>>
			components: { schemas: Record<string, { enum?: string[] }> }
		}>("/openapi.json")
		expect(doc.body.paths["/v1/dash/permissions"]!.get!["x-gezcez-permission"]).toEqual({
			key: "permissions.read",
			scope: "global",
		})
		expect(doc.body.components.schemas.PermissionKey?.enum).toContain("analytics.read")
	})
})

describe("role assignment level rules", () => {
	function asUser(email: string): Request {
		return { auth: { userId: userId(email) }, id: "test" } as unknown as Request
	}

	test("a network admin grants lower roles in their network only", () => {
		const roles = t.app.get(RolesService)
		const cache = t.app.get(PermissionCacheService)
		const ulasimpark = networkId("kocaeli-ulasimpark")
		const other = networkId("test-network-b")
		const rider = userId("rider@test.gezcez.com")

		roles.grant(asUser("netadmin@test.gezcez.com"), {
			targetUserId: rider,
			roleKey: "viewer",
			networkId: ulasimpark,
		})
		expect(cache.forUser(rider).byNetwork.get(ulasimpark)?.has("catalog.read")).toBe(true)

		expect(() =>
			roles.grant(asUser("netadmin@test.gezcez.com"), {
				targetUserId: rider,
				roleKey: "network_admin",
				networkId: ulasimpark,
			}),
		).toThrow(expect.objectContaining({ code: "ROLE_LEVEL_TOO_LOW" }))
		expect(() =>
			roles.grant(asUser("netadmin@test.gezcez.com"), {
				targetUserId: rider,
				roleKey: "viewer",
				networkId: other,
			}),
		).toThrow(expect.objectContaining({ code: "ROLE_LEVEL_TOO_LOW" }))
		expect(() =>
			roles.grant(asUser("netadmin@test.gezcez.com"), {
				targetUserId: rider,
				roleKey: "viewer",
			}),
		).toThrow(expect.objectContaining({ code: "ROLE_LEVEL_TOO_LOW" }))

		roles.revoke(asUser("netadmin@test.gezcez.com"), {
			targetUserId: rider,
			roleKey: "viewer",
			networkId: ulasimpark,
		})
		expect(cache.forUser(rider).byNetwork.size).toBe(0)
	})

	test("nobody edits themselves, peers or higher users, and root stays seed-only", () => {
		const roles = t.app.get(RolesService)
		const admin = asUser("admin@test.gezcez.com")
		expect(() =>
			roles.grant(admin, {
				targetUserId: userId("admin@test.gezcez.com"),
				roleKey: "viewer",
			}),
		).toThrow(expect.objectContaining({ code: "ROLE_LEVEL_TOO_LOW" }))
		expect(() =>
			roles.grant(asUser("analyst@test.gezcez.com"), {
				targetUserId: userId("netadmin@test.gezcez.com"),
				roleKey: "viewer",
				networkId: networkId("kocaeli-ulasimpark"),
			}),
		).toThrow(expect.objectContaining({ code: "ROLE_LEVEL_TOO_LOW" }))
		expect(() =>
			roles.grant(asUser("root@test.gezcez.com"), {
				targetUserId: userId("rider@test.gezcez.com"),
				roleKey: "root",
			}),
		).toThrow(expect.objectContaining({ code: "ROLE_IMMUTABLE" }))

		// An admin may manage a moderator globally.
		roles.grant(admin, {
			targetUserId: userId("moderator@test.gezcez.com"),
			roleKey: "viewer",
		})
	})

	test("audit rows are written for grants and revokes", () => {
		const rows = db()
			.select({ action: auditLogTable.action })
			.from(auditLogTable)
			.where(like(auditLogTable.action, "roles.%"))
			.all()
		expect(rows.map((row) => row.action)).toEqual([
			"roles.grant",
			"roles.revoke",
			"roles.grant",
		])
	})
})
