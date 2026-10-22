import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { auditLogTable, rolesTable, usersTable } from "@schemas/core"
import { newId } from "@common/utils"
import { createTestApp, type TestApp } from "../helpers/app"
import { DashClient, FIXTURE } from "../helpers/dash"
import { accessTokenFor } from "../helpers/oauth-client"

let t: TestApp
let dash: DashClient

interface Page<T> {
	items: T[]
	next_cursor: string | null
	prev_cursor: string | null
	total: number | null
}
interface ListItem {
	id: string
	display_name: string
	email_masked: string
	status: string
	role_count: number
}

beforeAll(async () => {
	t = await createTestApp()
	dash = new DashClient(t)
	const now = Date.now()
	for (let i = 0; i < 5; i++) {
		dash.db
			.insert(usersTable)
			.values({
				public_id: newId(),
				email: `paging${i}@example.com`,
				email_verified_at: i === 4 ? null : new Date(now),
				display_name: `Paging User ${i}`,
				created_at: new Date(now - i * 1000),
			})
			.run()
	}
})
afterAll(async () => {
	await t.close()
})

const roleId = (key: string) =>
	dash.db.select().from(rolesTable).where(eq(rolesTable.key, key)).get()!.id

describe("GET /v1/dash/users", () => {
	test("pages with opaque cursors, masks emails and counts the total", async () => {
		const first = await dash.get<Page<ListItem>>(
			FIXTURE.admin,
			"/v1/dash/users?q=paging&limit=2",
		)
		expect(first.status).toBe(200)
		expect(first.body.data.total).toBe(5)
		expect(first.body.data.items.map((u) => u.display_name)).toEqual([
			"Paging User 0",
			"Paging User 1",
		])
		expect(first.body.data.items[0]!.email_masked).toBe("p***@example.com")
		expect(first.body.data.prev_cursor).toBeNull()
		const cursor = encodeURIComponent(first.body.data.next_cursor!)
		const second = await dash.get<Page<ListItem>>(
			FIXTURE.admin,
			`/v1/dash/users?q=paging&limit=2&cursor=${cursor}`,
		)
		expect(second.body.data.items.map((u) => u.display_name)).toEqual([
			"Paging User 2",
			"Paging User 3",
		])
		expect(second.body.data.prev_cursor).not.toBeNull()

		// A cursor is bound to its filters and sort.
		const stale = await dash.get(
			FIXTURE.admin,
			`/v1/dash/users?q=paging&sort=display_name:asc&limit=2&cursor=${cursor}`,
		)
		expect(stale.body.error.code).toBe("VALIDATION_FAILED")
		const badSort = await dash.get(FIXTURE.admin, "/v1/dash/users?sort=email:asc")
		expect(badSort.body.error.code).toBe("VALIDATION_FAILED")
		const tooMany = await dash.get(FIXTURE.admin, "/v1/dash/users?limit=500")
		expect(tooMany.body.error.code).toBe("VALIDATION_FAILED")
	})

	test("filters by status, role and network", async () => {
		const unverified = await dash.get<Page<ListItem>>(
			FIXTURE.admin,
			"/v1/dash/users?status=unverified",
		)
		expect(unverified.body.data.items.map((u) => u.display_name)).toEqual(["Paging User 4"])
		const netadmins = await dash.get<Page<ListItem>>(
			FIXTURE.admin,
			"/v1/dash/users?role=network_admin",
		)
		expect(netadmins.body.data.items.map((u) => u.display_name)).toEqual([
			"Network Admin Fixture",
		])
		expect(netadmins.body.data.items[0]!.role_count).toBe(1)
		const inNetwork = await dash.get<Page<ListItem>>(
			FIXTURE.admin,
			`/v1/dash/users?network_id=${dash.networkId("kocaeli-ulasimpark")}&sort=display_name`,
		)
		expect(inNetwork.body.data.items.map((u) => u.display_name)).toEqual([
			"Analyst Fixture",
			"Network Admin Fixture",
		])
	})

	test("email prefix search needs users.pii.read", async () => {
		const admin = await dash.get<Page<ListItem>>(FIXTURE.admin, "/v1/dash/users?q=rider%40")
		expect(admin.body.data.items).toHaveLength(1)
		const moderator = await dash.get<Page<ListItem>>(
			FIXTURE.moderator,
			"/v1/dash/users?q=rider%40",
		)
		expect(moderator.status).toBe(200)
		expect(moderator.body.data.items).toHaveLength(0)
		const noPermission = await dash.get(FIXTURE.analyst, "/v1/dash/users")
		expect(noPermission.body.error).toMatchObject({
			code: "PERMISSION_MISSING",
			details: { permission: "users.read" },
		})
	})
})

describe("user detail and email reveal", () => {
	test("detail lists roles everywhere with who granted them", async () => {
		const res = await dash.get<{
			id: string
			status: string
			email_verified: boolean
			methods: { password: boolean }
			roles: { network: { slug: string } | null; role: { key: string } }[]
			ban: unknown
		}>(FIXTURE.admin, `/v1/dash/users/${dash.publicId(FIXTURE.netadmin)}`)
		expect(res.status).toBe(200)
		expect(res.body.data).toMatchObject({
			status: "active",
			email_verified: true,
			methods: { password: false },
			ban: null,
		})
		expect(res.body.data.roles).toEqual([
			expect.objectContaining({
				network: {
					id: dash.networkId("kocaeli-ulasimpark"),
					slug: "kocaeli-ulasimpark",
					name: "UlaşımPark",
				},
				role: expect.objectContaining({ key: "network_admin" }),
			}),
		])
		const missing = await dash.get(FIXTURE.admin, `/v1/dash/users/${newId()}`)
		expect(missing.status).toBe(404)
	})

	test("reveal-email needs users.pii.read and is audited", async () => {
		const rider = dash.publicId(FIXTURE.rider)
		const denied = await dash.call(
			FIXTURE.moderator,
			"POST",
			`/v1/dash/users/${rider}/reveal-email`,
		)
		expect(denied.body.error.code).toBe("PERMISSION_MISSING")
		const res = await dash.call<{ email: string }>(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${rider}/reveal-email`,
		)
		expect(res.status).toBe(200)
		expect(res.body.data.email).toBe(FIXTURE.rider)
		const row = dash.db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.action, "users.email_revealed"))
			.get()
		expect(row).toMatchObject({
			actor_user_id: dash.user(FIXTURE.admin).id,
			target_type: "user",
			target_id: String(dash.user(FIXTURE.rider).id),
		})
	})

	test("activity shows entries with the user as actor or target, by public id", async () => {
		const rider = dash.publicId(FIXTURE.rider)
		const res = await dash.get<
			Page<{
				action: string
				actor: { id: string } | null
				target_id: string
				target_label: string
				severity: string
				after: unknown
			}>
		>(FIXTURE.admin, `/v1/dash/users/${rider}/activity`)
		expect(res.status).toBe(200)
		const reveal = res.body.data.items.find((e) => e.action === "users.email_revealed")
		expect(reveal).toMatchObject({
			actor: { id: dash.publicId(FIXTURE.admin), display_name: "Admin Fixture" },
			target_id: rider,
			target_label: "Rider Fixture",
			severity: "warn",
		})
	})
})

describe("admin session management", () => {
	test("lists SSO sessions and refresh families, revokes one, then all", async () => {
		const rider = dash.publicId(FIXTURE.rider)
		const signedIn = await accessTokenFor(t, FIXTURE.rider, {
			clientId: "e2e_client",
			scope: "openid offline_access",
		})
		const list = await dash.get<
			{ id: string; kind: string; app: { client_id: string } | null }[]
		>(FIXTURE.admin, `/v1/dash/users/${rider}/sessions`)
		expect(list.status).toBe(200)
		const family = list.body.data.find((s) => s.kind === "refresh")
		expect(family).toMatchObject({ app: { client_id: "e2e_client", name: "E2E client" } })
		expect(list.body.data.some((s) => s.kind === "sso" && s.app === null)).toBe(true)

		const needsReason = await dash.call(
			FIXTURE.admin,
			"DELETE",
			`/v1/dash/users/${rider}/sessions/${family!.id}`,
			{},
		)
		expect(needsReason.body.error.code).toBe("VALIDATION_FAILED")
		const one = await dash.call<{ revoked: number }>(
			FIXTURE.admin,
			"DELETE",
			`/v1/dash/users/${rider}/sessions/${family!.id}`,
			{ reason: "lost phone" },
		)
		expect(one.body.data.revoked).toBe(1)
		const again = await dash.call(
			FIXTURE.admin,
			"DELETE",
			`/v1/dash/users/${rider}/sessions/${family!.id}`,
			{
				reason: "lost phone",
			},
		)
		expect(again.status).toBe(404)

		const stale = await dash.withStaleAuth(() =>
			dash.call(FIXTURE.admin, "POST", `/v1/dash/users/${rider}/sessions/revoke-all`, {
				reason: "compromised",
			}),
		)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		expect((await dash.get(null, "/v1/me")).status).toBe(401)
		const all = await dash.call<{ revoked: number }>(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${rider}/sessions/revoke-all`,
			{ reason: "compromised" },
		)
		expect(all.status).toBe(200)
		expect(all.body.data.revoked).toBeGreaterThanOrEqual(1)
		const me = await t.json<{ error: { code: string } }>("/v1/me", {
			headers: { authorization: `Bearer ${signedIn.accessToken}` },
		})
		expect(me.body.error.code).toBe("AUTH_SESSION_REVOKED")
		const after = await dash.get<unknown[]>(FIXTURE.admin, `/v1/dash/users/${rider}/sessions`)
		expect(after.body.data).toEqual([])
	})
})

describe("POST /v1/dash/users/:userId/roles", () => {
	test("applies each operation under the level rules and reports results", async () => {
		const rider = dash.publicId(FIXTURE.rider)
		const res = await dash.call<{
			results: { role_id: number; ok: boolean; error_code: string | null }[]
		}>(FIXTURE.admin, "POST", `/v1/dash/users/${rider}/roles`, {
			operations: [
				{ role_id: roleId("moderator"), op: "grant" },
				{ role_id: roleId("admin"), op: "grant" },
				{ role_id: roleId("root"), op: "grant" },
				{ role_id: 99_999, op: "grant" },
				{ role_id: roleId("viewer"), op: "revoke" },
			],
		})
		expect(res.status).toBe(200)
		expect(res.body.data.results.map((r) => [r.ok, r.error_code])).toEqual([
			[true, null],
			[false, "ROLE_LEVEL_TOO_LOW"],
			[false, "ROLE_IMMUTABLE"],
			[false, "NOT_FOUND"],
			[true, null],
		])
		const detail = await dash.get<{
			roles: { role: { key: string }; granted_by: { id: string } }[]
		}>(FIXTURE.admin, `/v1/dash/users/${rider}`)
		expect(detail.body.data.roles).toEqual([
			expect.objectContaining({
				role: expect.objectContaining({ key: "moderator" }),
				granted_by: expect.objectContaining({ id: dash.publicId(FIXTURE.admin) }),
			}),
		])

		const self = await dash.call<{ results: { error_code: string }[] }>(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${dash.publicId(FIXTURE.admin)}/roles`,
			{ operations: [{ role_id: roleId("viewer"), op: "grant" }] },
		)
		expect(self.body.data.results[0]!.error_code).toBe("ROLE_LEVEL_TOO_LOW")

		const stale = await dash.withStaleAuth(() =>
			dash.call(FIXTURE.admin, "POST", `/v1/dash/users/${rider}/roles`, {
				operations: [{ role_id: roleId("moderator"), op: "revoke" }],
			}),
		)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		const revoked = await dash.call<{ results: { ok: boolean }[] }>(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${rider}/roles`,
			{ operations: [{ role_id: roleId("moderator"), op: "revoke" }] },
		)
		expect(revoked.body.data.results[0]!.ok).toBe(true)
	})
})

describe("audit log", () => {
	test("global query filters by action prefix and actor; network query is scoped", async () => {
		const res = await dash.get<Page<{ action: string; actor: { id: string } }>>(
			FIXTURE.admin,
			`/v1/dash/audit?action=roles.*&actor=${dash.publicId(FIXTURE.admin)}`,
		)
		expect(res.status).toBe(200)
		expect(res.body.data.items.length).toBeGreaterThan(0)
		expect(res.body.data.items.every((e) => e.action.startsWith("roles."))).toBe(true)
		const nobody = await dash.get<Page<unknown>>(
			FIXTURE.admin,
			`/v1/dash/audit?actor=${newId()}`,
		)
		expect(nobody.body.data.items).toEqual([])
		const bad = await dash.get(FIXTURE.admin, "/v1/dash/audit?sort=action")
		expect(bad.body.error.code).toBe("VALIDATION_FAILED")

		const netadmin = await dash.get<Page<{ network_id: number }>>(
			FIXTURE.netadmin,
			"/v1/dash/networks/kocaeli-ulasimpark/audit",
		)
		expect(netadmin.status).toBe(200)
		const other = await dash.get(FIXTURE.netadmin, "/v1/dash/networks/test-network-b/audit")
		expect(other.body.error.code).toBe("PERMISSION_MISSING")
		const global = await dash.get(FIXTURE.netadmin, "/v1/dash/audit")
		expect(global.body.error.code).toBe("PERMISSION_MISSING")
	})
})
