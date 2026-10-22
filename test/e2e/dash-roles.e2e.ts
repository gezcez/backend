import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { permissionsTable, rolePermissionsTable, rolesTable } from "@schemas/core"
import { PermissionRegistryService } from "@services/roles/permission-registry.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { DashClient, FIXTURE } from "../helpers/dash"

let t: TestApp
let dash: DashClient

beforeAll(async () => {
	t = await createTestApp()
	dash = new DashClient(t)
})
afterAll(async () => {
	await t.close()
})

const roleId = (key: string) =>
	dash.db.select().from(rolesTable).where(eq(rolesTable.key, key)).get()!.id

interface Role {
	id: number
	key: string
	level: number
	immutable: boolean
	permission_count: number
	member_count: number
}
interface Results {
	results: { ok: boolean; error_code: string | null }[]
}

describe("roles", () => {
	test("list and detail carry counts, permissions and members per network", async () => {
		const list = await dash.get<Role[]>(FIXTURE.admin, "/v1/dash/roles")
		expect(list.status).toBe(200)
		expect(list.body.data[0]).toMatchObject({ key: "root", immutable: true })
		const netadmin = list.body.data.find((role) => role.key === "network_admin")!
		expect(netadmin.member_count).toBe(1)
		const detail = await dash.get<{
			permissions: string[]
			members_by_network: { network: { slug: string } | null; count: number }[]
		}>(FIXTURE.admin, `/v1/dash/roles/${netadmin.id}`)
		expect(detail.body.data.permissions).toContain("tracker.control")
		expect(detail.body.data.members_by_network).toEqual([
			{ network: expect.objectContaining({ slug: "kocaeli-ulasimpark" }), count: 1 },
		])
		expect((await dash.get(FIXTURE.admin, "/v1/dash/roles/99999")).status).toBe(404)
		expect((await dash.get(FIXTURE.admin, "/v1/dash/roles/abc")).status).toBe(404)
	})

	test("create and edit stay below the editor's level; immutable roles are refused", async () => {
		const tooHigh = await dash.call(FIXTURE.admin, "POST", "/v1/dash/roles", {
			key: "boss",
			name: "Boss",
			level: 900,
		})
		expect(tooHigh.body.error.code).toBe("ROLE_LEVEL_TOO_LOW")
		const badKey = await dash.call(FIXTURE.admin, "POST", "/v1/dash/roles", {
			key: "Bad Key",
			name: "Bad",
			level: 10,
		})
		expect(badKey.body.error.code).toBe("VALIDATION_FAILED")
		const stale = await dash.withStaleAuth(() =>
			dash.call(FIXTURE.admin, "POST", "/v1/dash/roles", {
				key: "support",
				name: "Support",
				level: 250,
			}),
		)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")

		const created = await dash.call<Role>(FIXTURE.admin, "POST", "/v1/dash/roles", {
			key: "support",
			name: "Support",
			description: "Answers tickets",
			level: 250,
		})
		expect(created.body.data).toMatchObject({
			key: "support",
			level: 250,
			immutable: false,
			permission_count: 0,
			member_count: 0,
		})
		const duplicate = await dash.call(FIXTURE.admin, "POST", "/v1/dash/roles", {
			key: "support",
			name: "Support",
			level: 250,
		})
		expect(duplicate.body.error).toMatchObject({
			code: "CONFLICT",
			details: { fields: { key: "taken" } },
		})

		const renamed = await dash.call<Role & { name: string }>(
			FIXTURE.admin,
			"PATCH",
			`/v1/dash/roles/${created.body.data.id}`,
			{ name: "Support desk" },
		)
		expect(renamed.body.data.name).toBe("Support desk")
		const raise = await dash.call(
			FIXTURE.admin,
			"PATCH",
			`/v1/dash/roles/${created.body.data.id}`,
			{
				level: 950,
			},
		)
		expect(raise.body.error.code).toBe("ROLE_LEVEL_TOO_LOW")
		const root = await dash.call(FIXTURE.root, "PATCH", `/v1/dash/roles/${roleId("root")}`, {
			name: "Root!",
		})
		expect(root.body.error.code).toBe("ROLE_IMMUTABLE")
		const admin = await dash.call(FIXTURE.admin, "PATCH", `/v1/dash/roles/${roleId("admin")}`, {
			name: "Admin!",
		})
		expect(admin.body.error.code).toBe("ROLE_LEVEL_TOO_LOW")
		const empty = await dash.call(
			FIXTURE.admin,
			"PATCH",
			`/v1/dash/roles/${created.body.data.id}`,
			{},
		)
		expect(empty.body.error.code).toBe("VALIDATION_FAILED")
	})
})

describe("permission matrix", () => {
	test("matrix lists roles, keys and grants; root holds every key", async () => {
		const res = await dash.get<{
			roles: Role[]
			permissions: { key: string; scope: string; sudo: boolean }[]
			grants: { role_id: number; permissions: string[] }[]
		}>(FIXTURE.admin, "/v1/dash/roles/permission-matrix")
		expect(res.status).toBe(200)
		const keys = res.body.data.permissions.map((p) => p.key)
		expect(res.body.data.grants.find((g) => g.role_id === roleId("root"))?.permissions).toEqual(
			keys,
		)
		expect(
			res.body.data.grants.find((g) => g.role_id === roleId("moderator"))?.permissions,
		).toEqual(["audit.read", "moderation.read", "moderation.write", "users.read"])
	})

	test("batch grants only what the editor holds and reports each operation", async () => {
		const support = roleId("support")
		const res = await dash.call<Results>(
			FIXTURE.admin,
			"POST",
			"/v1/dash/roles/permissions:batch",
			{
				operations: [
					{ role_id: support, permission_key: "users.read", op: "grant" },
					{ role_id: support, permission_key: "providers.kill", op: "grant" },
					{ role_id: roleId("root"), permission_key: "users.read", op: "revoke" },
					{ role_id: roleId("admin"), permission_key: "users.read", op: "revoke" },
					{ role_id: 99_999, permission_key: "users.read", op: "grant" },
				],
			},
		)
		expect(res.status).toBe(200)
		expect(res.body.data.results.map((r) => r.error_code)).toEqual([
			null,
			"PERMISSION_MISSING",
			"ROLE_IMMUTABLE",
			"ROLE_LEVEL_TOO_LOW",
			"NOT_FOUND",
		])
		const keys = dash.db
			.select()
			.from(rolePermissionsTable)
			.where(eq(rolePermissionsTable.role_id, support))
			.all()
			.map((row) => row.permission_key)
		expect(keys).toEqual(["users.read"])
		const unknown = await dash.call(FIXTURE.admin, "POST", "/v1/dash/roles/permissions:batch", {
			operations: [{ role_id: support, permission_key: "made.up", op: "grant" }],
		})
		expect(unknown.body.error.code).toBe("VALIDATION_FAILED")
	})

	test("PUT replaces a role's permission set and takes effect for holders at once", async () => {
		const support = roleId("support")
		const rider = dash.publicId(FIXTURE.rider)
		const assign = await dash.call<Results>(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${rider}/roles`,
			{
				operations: [{ role_id: support, op: "grant" }],
			},
		)
		expect(assign.body.data.results[0]!.ok).toBe(true)
		// The rider can read users now (cache warmed by this call) ...
		expect((await dash.get(FIXTURE.rider, "/v1/dash/users")).status).toBe(200)

		const notHeld = await dash.call(
			FIXTURE.admin,
			"PUT",
			`/v1/dash/roles/${support}/permissions`,
			{
				permissions: ["users.read", "providers.kill"],
			},
		)
		expect(notHeld.body.error).toMatchObject({
			code: "PERMISSION_MISSING",
			details: { permissions: ["providers.kill"] },
		})
		const replaced = await dash.call<{ permissions: string[] }>(
			FIXTURE.admin,
			"PUT",
			`/v1/dash/roles/${support}/permissions`,
			{ permissions: ["moderation.read"] },
		)
		expect(replaced.body.data.permissions).toEqual(["moderation.read"])
		// ... and loses it immediately: role edits drop the permission cache.
		expect((await dash.get(FIXTURE.rider, "/v1/dash/users")).body.error.code).toBe(
			"PERMISSION_MISSING",
		)
		expect((await dash.get(FIXTURE.rider, "/v1/dash/moderation")).status).toBe(200)
	})
})

describe("permission registry", () => {
	test("lists routes and holders, flags orphans, deletes only orphans", async () => {
		dash.db
			.insert(permissionsTable)
			.values({
				key: "legacy.thing",
				scope: "global",
				description: "old",
				first_seen_at: new Date(0),
			})
			.run()
		dash.db
			.insert(rolePermissionsTable)
			.values({
				role_id: roleId("admin"),
				permission_key: "legacy.thing",
				created_at: new Date(),
			})
			.run()
		t.app.get(PermissionRegistryService).onApplicationBootstrap()

		const registry = await dash.get<
			{
				key: string
				routes: { method: string; path: string; sudo: boolean }[]
				roles: { key: string }[]
				orphaned_at: string | null
			}[]
		>(FIXTURE.admin, "/v1/dash/permissions/registry")
		const batch = registry.body.data.find((entry) => entry.key === "roles.write")!
		expect(batch.routes).toContainEqual({
			method: "POST",
			path: "/v1/dash/roles/permissions:batch",
			sudo: true,
		})
		const legacy = registry.body.data.find((entry) => entry.key === "legacy.thing")!
		expect(legacy.orphaned_at).not.toBeNull()
		expect(legacy.roles.map((role) => role.key)).toEqual(["admin"])

		// admin lacks permissions.write; root holds everything.
		const denied = await dash.call(FIXTURE.admin, "DELETE", "/v1/dash/permissions/legacy.thing")
		expect(denied.body.error.code).toBe("PERMISSION_MISSING")
		const live = await dash.call(FIXTURE.root, "DELETE", "/v1/dash/permissions/users.read")
		expect(live.body.error.code).toBe("CONFLICT")
		const deleted = await dash.call<{ deleted: boolean }>(
			FIXTURE.root,
			"DELETE",
			"/v1/dash/permissions/legacy.thing",
		)
		expect(deleted.body.data).toEqual({ deleted: true })
		expect(
			dash.db
				.select()
				.from(rolePermissionsTable)
				.where(eq(rolePermissionsTable.permission_key, "legacy.thing"))
				.all(),
		).toEqual([])
		expect(
			(await dash.call(FIXTURE.root, "DELETE", "/v1/dash/permissions/legacy.thing")).status,
		).toBe(404)
	})
})

describe("network members", () => {
	const members = (as: string, network = "kocaeli-ulasimpark", query = "") =>
		dash.get<{
			items: {
				user: { id: string; display_name: string }
				email_masked: string
				roles: { role: { key: string } }[]
			}[]
			total: number
		}>(as, `/v1/dash/networks/${network}/members${query}`)

	test("lists members with masked emails, highest level first", async () => {
		const res = await members(FIXTURE.netadmin)
		expect(res.status).toBe(200)
		expect(res.body.data.items.map((m) => m.user.display_name)).toEqual([
			"Network Admin Fixture",
			"Analyst Fixture",
		])
		expect(res.body.data.items[1]!.email_masked).toBe("a***@test.gezcez.com")
		const analysts = await members(FIXTURE.netadmin, "kocaeli-ulasimpark", "?role=analyst")
		expect(analysts.body.data.total).toBe(1)
		const byId = await members(FIXTURE.netadmin, String(dash.networkId("kocaeli-ulasimpark")))
		expect(byId.body.data.total).toBe(2)
		expect((await members(FIXTURE.netadmin, "test-network-b")).body.error.code).toBe(
			"PERMISSION_MISSING",
		)
		expect((await members(FIXTURE.netadmin, "nowhere")).status).toBe(404)
	})

	test("adds a member with the level rules, using candidates and assignable roles", async () => {
		const candidates = await dash.get<{ id: string; display_name: string }[]>(
			FIXTURE.netadmin,
			"/v1/dash/networks/kocaeli-ulasimpark/members/candidates?q=Rider",
		)
		expect(candidates.body.data.map((u) => u.display_name)).toEqual(["Rider Fixture"])
		const byEmail = await dash.get<unknown[]>(
			FIXTURE.netadmin,
			`/v1/dash/networks/kocaeli-ulasimpark/members/candidates?q=${encodeURIComponent(FIXTURE.rider)}`,
		)
		expect(byEmail.body.data).toEqual([])

		const assignable = await dash.get<{ key: string }[]>(
			FIXTURE.netadmin,
			"/v1/dash/networks/kocaeli-ulasimpark/members/assignable-roles",
		)
		expect(assignable.body.data.map((role) => role.key)).toEqual(["analyst", "viewer"])

		const rider = candidates.body.data[0]!.id
		const res = await dash.call<Results>(
			FIXTURE.netadmin,
			"POST",
			`/v1/dash/networks/kocaeli-ulasimpark/members/${rider}/roles`,
			{
				operations: [
					{ role_id: roleId("viewer"), op: "grant" },
					{ role_id: roleId("network_admin"), op: "grant" },
				],
			},
		)
		expect(res.body.data.results.map((r) => r.error_code)).toEqual([null, "ROLE_LEVEL_TOO_LOW"])
		const after = await members(FIXTURE.netadmin)
		expect(after.body.data.total).toBe(3)
		const other = await dash.call(
			FIXTURE.netadmin,
			"POST",
			`/v1/dash/networks/test-network-b/members/${rider}/roles`,
			{
				operations: [{ role_id: roleId("viewer"), op: "grant" }],
			},
		)
		expect(other.body.error.code).toBe("PERMISSION_MISSING")
		const audit = await dash.get<{ items: { action: string; network_id: number }[] }>(
			FIXTURE.netadmin,
			"/v1/dash/networks/kocaeli-ulasimpark/audit?action=roles.grant",
		)
		expect(audit.body.data.items[0]).toMatchObject({
			action: "roles.grant",
			network_id: dash.networkId("kocaeli-ulasimpark"),
		})
	})
})
