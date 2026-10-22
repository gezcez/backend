import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { appsTable, refreshTokensTable } from "@schemas/core"
import { createTestApp, type TestApp } from "../helpers/app"
import { DashClient, FIXTURE } from "../helpers/dash"
import { accessTokenFor } from "../helpers/oauth-client"

let t: TestApp
let dash: DashClient

beforeAll(async () => {
	t = await createTestApp()
	dash = new DashClient(t)
})
afterAll(async () => {
	await t.close()
})

interface Secret {
	id: string
	prefix: string
	state: string
	last_used_at: string | null
	expires_at: string | null
}
interface App {
	client_id: string
	type: string
	platform: string
	redirect_uris: string[]
	scopes: string[]
	secrets: Secret[]
	tokens_24h: number
	active_families: number
	usage: { date: string; tokens: number }[]
}

/** RFC 7009 revoke with HTTP Basic client auth: 200 when the secret is accepted. */
async function secretWorks(clientId: string, secret: string): Promise<boolean> {
	const res = await t.fetch("/v1/oauth/revoke", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
		},
		body: new URLSearchParams({ token: "unknown-token" }),
	})
	return res.status === 200
}

describe("apps", () => {
	test("lists clients with usage counts", async () => {
		await dash.token(FIXTURE.admin)
		const res = await dash.get<{ items: (App & { redirect_uri_count: number })[] }>(
			FIXTURE.admin,
			"/v1/dash/apps?q=dashboard",
		)
		expect(res.status).toBe(200)
		const app = res.body.data.items.find((item) => item.client_id === "dashboard-dev")!
		expect(app).toMatchObject({ platform: "dev", redirect_uri_count: 2 })
		expect(app.tokens_24h).toBeGreaterThan(0)
		const detail = await dash.get<App>(FIXTURE.admin, "/v1/dash/apps/dashboard-dev")
		expect(detail.body.data.usage.at(-1)?.tokens).toBeGreaterThan(0)
		expect((await dash.get(FIXTURE.analyst, "/v1/dash/apps")).body.error.code).toBe(
			"PERMISSION_MISSING",
		)
	})

	test("creates a confidential client and rotates its secret with a grace period", async () => {
		const bad = await dash.call(FIXTURE.admin, "POST", "/v1/dash/apps", {
			name: "Partner",
			type: "confidential",
			platform: "web",
			redirect_uris: ["http://partner.example/cb", "https://*.partner.example/cb"],
		})
		expect(bad.body.error.code).toBe("VALIDATION_FAILED")
		expect(
			String(
				bad.body.error.details?.fields &&
					(bad.body.error.details.fields as Record<string, string>).redirect_uris,
			),
		).toContain("https_required")

		const created = await dash.call<{ app: App; secret: string }>(
			FIXTURE.admin,
			"POST",
			"/v1/dash/apps",
			{
				name: "Partner Ağı",
				description: "A partner",
				type: "confidential",
				platform: "web",
				homepage_url: "https://partner.example",
				redirect_uris: ["https://partner.example/cb"],
			},
		)
		expect(created.status).toBe(200)
		const { app, secret } = created.body.data
		expect(app).toMatchObject({ client_id: "partner-agi", scopes: ["openid", "profile"] })
		expect(app.secrets).toEqual([
			expect.objectContaining({ state: "current", prefix: secret.slice(0, 8) }),
		])
		expect(await secretWorks(app.client_id, secret)).toBe(true)
		expect(await secretWorks(app.client_id, "gzs_wrong")).toBe(false)

		const stale = await dash.withStaleAuth(() =>
			dash.call(FIXTURE.admin, "POST", `/v1/dash/apps/${app.client_id}/secret`, {
				grace: "24h",
			}),
		)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		const rotated = await dash.call<{ secret: string; meta: Secret }>(
			FIXTURE.admin,
			"POST",
			`/v1/dash/apps/${app.client_id}/secret`,
			{ grace: "24h" },
		)
		const next = rotated.body.data.secret
		expect(next).not.toBe(secret)
		expect(await secretWorks(app.client_id, secret)).toBe(true)
		expect(await secretWorks(app.client_id, next)).toBe(true)
		const detail = await dash.get<App>(FIXTURE.admin, `/v1/dash/apps/${app.client_id}`)
		expect(detail.body.data.secrets.map((s) => s.state)).toEqual(["current", "previous"])
		expect(detail.body.data.secrets.every((s) => s.last_used_at !== null)).toBe(true)

		const revoked = await dash.call<{ revoked: boolean }>(
			FIXTURE.admin,
			"DELETE",
			`/v1/dash/apps/${app.client_id}/secret/previous`,
		)
		expect(revoked.body.data).toEqual({ revoked: true })
		expect(await secretWorks(app.client_id, secret)).toBe(false)

		await dash.call(FIXTURE.admin, "POST", `/v1/dash/apps/${app.client_id}/secret`, {
			grace: "none",
		})
		expect(await secretWorks(app.client_id, next)).toBe(false)

		const publicApp = await dash.call(
			FIXTURE.admin,
			"POST",
			`/v1/dash/apps/dashboard-dev/secret`,
			{
				grace: "none",
			},
		)
		expect(publicApp.body.error.code).toBe("CONFLICT")
	})

	test("redirect URIs and first-party need a fresh sign-in; other edits do not", async () => {
		const stale = await dash.withStaleAuth(async () => ({
			name: await dash.call<App & { name: string }>(
				FIXTURE.admin,
				"PATCH",
				"/v1/dash/apps/partner-agi",
				{
					name: "Partner network",
				},
			),
			uris: await dash.call(FIXTURE.admin, "PATCH", "/v1/dash/apps/partner-agi", {
				redirect_uris: ["https://partner.example/callback"],
			}),
			firstParty: await dash.call(FIXTURE.admin, "PATCH", "/v1/dash/apps/partner-agi", {
				first_party: true,
			}),
		}))
		expect(stale.name.body.data.name).toBe("Partner network")
		expect(stale.uris.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		expect(stale.firstParty.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")

		const uris = await dash.call<App>(FIXTURE.admin, "PATCH", "/v1/dash/apps/partner-agi", {
			redirect_uris: ["https://partner.example/callback"],
			scopes: ["openid", "email", "offline_access"],
		})
		expect(uris.body.data).toMatchObject({
			redirect_uris: ["https://partner.example/callback"],
			scopes: ["openid", "email", "offline_access"],
		})
		const custom = await dash.call(FIXTURE.admin, "PATCH", "/v1/dash/apps/partner-agi", {
			redirect_uris: ["partner://cb"],
		})
		expect(custom.body.error.code).toBe("VALIDATION_FAILED")
		const scope = await dash.call(FIXTURE.admin, "PATCH", "/v1/dash/apps/partner-agi", {
			scopes: ["root"],
		})
		expect(scope.body.error.code).toBe("VALIDATION_FAILED")
		const ttl = await dash.call(FIXTURE.admin, "PATCH", "/v1/dash/apps/partner-agi", {
			refresh_ttl_s: 86_400,
			refresh_max_s: 3600,
		})
		expect(ttl.body.error.code).toBe("VALIDATION_FAILED")
	})

	test("revoke-all ends every refresh family; refresh_max_s caps a family's age", async () => {
		const first = await accessTokenFor(t, FIXTURE.rider, {
			clientId: "e2e_client",
			scope: "openid offline_access",
		})
		const refresh = (token: string) =>
			t.json<{ error?: string; refresh_token?: string }>("/v1/oauth/token", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: token,
					client_id: "e2e_client",
				}),
			})
		const before = await dash.get<App>(FIXTURE.admin, "/v1/dash/apps/e2e_client")
		expect(before.body.data.active_families).toBeGreaterThanOrEqual(1)
		const all = await dash.call<{ revoked: number }>(
			FIXTURE.admin,
			"POST",
			"/v1/dash/apps/e2e_client/revoke-all",
			{
				reason: "incident",
			},
		)
		expect(all.body.data.revoked).toBeGreaterThanOrEqual(1)
		expect((await refresh(first.refreshToken!)).body.error).toBe("invalid_grant")

		const second = await accessTokenFor(t, FIXTURE.rider, {
			clientId: "e2e_client",
			scope: "openid offline_access",
		})
		dash.db
			.update(appsTable)
			.set({ refresh_max_s: 3600 })
			.where(eq(appsTable.client_id, "e2e_client"))
			.run()
		dash.db
			.update(refreshTokensTable)
			.set({ created_at: new Date(Date.now() - 2 * 3600_000) })
			.where(eq(refreshTokensTable.client_id, "e2e_client"))
			.run()
		expect((await refresh(second.refreshToken!)).body.error).toBe("invalid_grant")
	})

	test("system apps cannot be deleted; others go with their tokens", async () => {
		dash.db
			.update(appsTable)
			.set({ system: true })
			.where(eq(appsTable.client_id, "mobile-dev"))
			.run()
		const system = await dash.call(FIXTURE.admin, "DELETE", "/v1/dash/apps/mobile-dev")
		expect(system.body.error.code).toBe("CONFLICT")
		const deleted = await dash.call<{ deleted: boolean }>(
			FIXTURE.admin,
			"DELETE",
			"/v1/dash/apps/partner-agi",
		)
		expect(deleted.body.data).toEqual({ deleted: true })
		expect((await dash.get(FIXTURE.admin, "/v1/dash/apps/partner-agi")).status).toBe(404)
	})
})
