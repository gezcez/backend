import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { moderationActionsTable, usersTable } from "@schemas/core"
import { createTestApp, type TestApp } from "../helpers/app"
import { DashClient, FIXTURE } from "../helpers/dash"
import { accessTokenFor } from "../helpers/oauth-client"
import { TestBrowser } from "../helpers/browser"

let t: TestApp
let dash: DashClient

beforeAll(async () => {
	t = await createTestApp()
	dash = new DashClient(t)
})
afterAll(async () => {
	await t.close()
})

interface ModerationRow {
	action: string
	active: boolean
	user: { id: string }
	by: { id: string } | null
	public_reason: string
	private_reason: string | null
	until: string | null
}

describe("ban and unban", () => {
	test("a ban ends every session and refresh family at once and blocks sign-in", async () => {
		const rider = dash.publicId(FIXTURE.rider)
		const signedIn = await accessTokenFor(t, FIXTURE.rider, {
			clientId: "e2e_client",
			scope: "openid offline_access",
		})
		const auth = { headers: { authorization: `Bearer ${signedIn.accessToken}` } }
		expect((await t.json("/v1/me", auth)).status).toBe(200)

		const stale = await dash.withStaleAuth(() =>
			dash.call(FIXTURE.moderator, "POST", `/v1/dash/users/${rider}/ban`, {
				public_reason: "spam",
				duration: "7d",
			}),
		)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		const invalid = await dash.call(FIXTURE.moderator, "POST", `/v1/dash/users/${rider}/ban`, {
			public_reason: "spam",
			duration: "2y",
		})
		expect(invalid.body.error.code).toBe("VALIDATION_FAILED")

		const before = Date.now()
		const ban = await dash.call<{
			public_reason: string
			private_reason: string
			until: string
			created_by: { id: string }
		}>(FIXTURE.moderator, "POST", `/v1/dash/users/${rider}/ban`, {
			public_reason: "Spam in reports",
			private_reason: "ticket 42",
			duration: "7d",
		})
		expect(ban.status).toBe(200)
		expect(ban.body.data).toMatchObject({
			public_reason: "Spam in reports",
			private_reason: "ticket 42",
			created_by: { id: dash.publicId(FIXTURE.moderator) },
		})
		const until = Date.parse(ban.body.data.until)
		expect(until - before).toBeGreaterThan(7 * 86_400_000 - 5000)

		// The access token dies on the next request; the refresh token is revoked.
		const me = await t.json<{ error: { code: string } }>("/v1/me", auth)
		expect(me.status).toBe(401)
		const refreshed = await t.json<{ error: string }>("/v1/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: signedIn.refreshToken!,
				client_id: "e2e_client",
			}),
		})
		expect(refreshed.body.error).toBe("invalid_grant")

		// Signing in again shows the public reason.
		expect(new TestBrowser(t).signIn(FIXTURE.rider)).rejects.toThrow(
			/USER_BANNED.*Spam in reports/,
		)

		const detail = await dash.get<{ status: string; ban: { public_reason: string } }>(
			FIXTURE.moderator,
			`/v1/dash/users/${rider}`,
		)
		expect(detail.body.data).toMatchObject({
			status: "banned",
			ban: { public_reason: "Spam in reports" },
		})

		const active = await dash.get<{ items: ModerationRow[] }>(
			FIXTURE.moderator,
			"/v1/dash/moderation?active=true",
		)
		expect(active.body.data.items).toEqual([
			expect.objectContaining({
				action: "ban",
				active: true,
				user: expect.objectContaining({ id: rider }),
			}),
		])

		const unban = await dash.call<{ unbanned: boolean }>(
			FIXTURE.moderator,
			"POST",
			`/v1/dash/users/${rider}/unban`,
			{ reason: "appeal accepted" },
		)
		expect(unban.body.data).toEqual({ unbanned: true })
		const twice = await dash.call(FIXTURE.moderator, "POST", `/v1/dash/users/${rider}/unban`, {
			reason: "appeal accepted",
		})
		expect(twice.body.error.code).toBe("CONFLICT")
		expect(dash.user(FIXTURE.rider)).toMatchObject({ status: "active", banned_until: null })

		const log = await dash.get<{ items: ModerationRow[] }>(
			FIXTURE.moderator,
			`/v1/dash/moderation?user_id=${rider}`,
		)
		expect(log.body.data.items.map((row) => [row.action, row.active])).toEqual([
			["unban", false],
			["ban", false],
		])
		const noneActive = await dash.get<{ items: unknown[] }>(
			FIXTURE.moderator,
			"/v1/dash/moderation?active=true",
		)
		expect(noneActive.body.data.items).toEqual([])
	})

	test("nobody bans themselves or someone at or above their level", async () => {
		const self = await dash.call(
			FIXTURE.moderator,
			"POST",
			`/v1/dash/users/${dash.publicId(FIXTURE.moderator)}/ban`,
			{
				public_reason: "test",
				duration: "1d",
			},
		)
		expect(self.body.error.code).toBe("ROLE_LEVEL_TOO_LOW")
		const admin = await dash.call(
			FIXTURE.moderator,
			"POST",
			`/v1/dash/users/${dash.publicId(FIXTURE.admin)}/ban`,
			{
				public_reason: "test",
				duration: "1d",
			},
		)
		expect(admin.body.error.code).toBe("ROLE_LEVEL_TOO_LOW")
		// A network admin (500) outranks a global moderator (300).
		const netadmin = await dash.call(
			FIXTURE.moderator,
			"POST",
			`/v1/dash/users/${dash.publicId(FIXTURE.netadmin)}/ban`,
			{ public_reason: "test", duration: "1d" },
		)
		expect(netadmin.body.error.code).toBe("ROLE_LEVEL_TOO_LOW")
		const noPermission = await dash.call(
			FIXTURE.analyst,
			"POST",
			`/v1/dash/users/${dash.publicId(FIXTURE.rider)}/ban`,
			{
				public_reason: "test",
				duration: "1d",
			},
		)
		expect(noPermission.body.error.code).toBe("PERMISSION_MISSING")
	})

	test("an expired ban is no longer active and lifts on sign-in", async () => {
		const rider = dash.publicId(FIXTURE.rider)
		await dash.call(FIXTURE.moderator, "POST", `/v1/dash/users/${rider}/ban`, {
			public_reason: "Short ban",
			duration: "1d",
		})
		dash.db
			.update(usersTable)
			.set({ banned_until: new Date(Date.now() - 1000) })
			.where(eq(usersTable.public_id, rider))
			.run()
		const active = await dash.get<{ items: unknown[] }>(
			FIXTURE.moderator,
			"/v1/dash/moderation?active=true",
		)
		expect(active.body.data.items).toEqual([])
		const detail = await dash.get<{ status: string; ban: unknown }>(
			FIXTURE.moderator,
			`/v1/dash/users/${rider}`,
		)
		expect(detail.body.data).toMatchObject({ status: "active", ban: null })
		const rows = dash.db
			.select()
			.from(moderationActionsTable)
			.where(eq(moderationActionsTable.target_user_id, dash.user(FIXTURE.rider).id))
			.all()
		expect(rows.filter((row) => row.action === "ban")).toHaveLength(2)
	})
})
