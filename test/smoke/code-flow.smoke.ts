// Smoke test against a running server, normally the published image in test mode:
//   docker run -e NODE_ENV=test -p 8080:8080 ghcr.io/gezcez/backend:<tag>
//   SMOKE_BASE_URL=http://localhost:8080 bun run test:smoke
// It completes the e2e_client authorization code flow with the seeded fixture user, the way a
// client repo's e2e suite does. Without SMOKE_BASE_URL it boots the app in process.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestApp, remoteTarget, type ApiTarget, type TestApp } from "../helpers/app"
import { TestBrowser } from "../helpers/browser"
import { claims, TestOAuthClient } from "../helpers/oauth-client"

const BASE_URL = process.env.SMOKE_BASE_URL
let target: ApiTarget
let local: TestApp | undefined

beforeAll(async () => {
	if (BASE_URL) {
		target = remoteTarget(
			BASE_URL,
			process.env.SMOKE_OAUTH_UI_URL ?? "http://localhost:5174",
			process.env.SMOKE_ISSUER ?? BASE_URL,
		)
	} else {
		local = await createTestApp()
		target = local
	}
})
afterAll(async () => {
	await local?.close()
})

describe("smoke", () => {
	test("probes and published documents", async () => {
		expect((await target.fetch("/health")).status).toBe(200)
		expect((await target.fetch("/ready")).status).toBe(200)
		const jwks = await target.json<{ keys: unknown[] }>("/.well-known/jwks.json")
		expect(jwks.body.keys.length).toBeGreaterThan(0)
		const doc = await target.json<{ openapi: string }>("/openapi.json")
		expect(doc.body.openapi).toStartWith("3.1")
	})

	test("e2e_client code flow, /v1/me and one refresh", async () => {
		const browser = new TestBrowser(target)
		const client = new TestOAuthClient(target)
		const start = await client.authorize(browser)
		expect(start.data.next).toBe("login")
		await browser.signIn("rider@test.gezcez.com", { requestId: start.data.request_id! })
		const next = await browser.post<{ next: string; redirect_to: string }>(
			`/v1/oauth/authorize/${start.data.request_id}/continue`,
		)
		expect(next.data.next).toBe("redirect")
		const { code, state } = client.callback(next.data.redirect_to)
		expect(state).toBe(client.state)

		const token = await client.exchange(code!)
		expect(token.status).toBe(200)
		expect(claims(token.body.access_token).aud).toBe("e2e_client")

		const me = await target.json<{ data: { user: { display_name: string } } }>("/v1/me", {
			headers: { authorization: `Bearer ${token.body.access_token}` },
		})
		expect(me.status).toBe(200)
		expect(me.body.data.user.display_name).toBeString()

		const refreshed = await client.refresh(token.body.refresh_token!)
		expect(refreshed.status).toBe(200)
		expect(refreshed.body.refresh_token).not.toBe(token.body.refresh_token)
	})
})
