import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createLocalJWKSet, jwtVerify } from "jose"
import { DatabaseService } from "@db"
import { appsTable } from "@schemas/core"
import { createTestApp, type TestApp } from "../helpers/app"
import { TestBrowser } from "../helpers/browser"
import { claims, E2E_REDIRECT, TestOAuthClient, type Snapshot } from "../helpers/oauth-client"

const DASH_ORIGIN = "http://localhost:5173"
const DASH_REDIRECT = `${DASH_ORIGIN}/auth/callback`

let t: TestApp

beforeAll(async () => {
	t = await createTestApp({ CORS_ORIGINS: DASH_ORIGIN })
})
afterAll(async () => {
	await t.close()
})

async function signedIn(email = "rider@test.gezcez.com") {
	const browser = new TestBrowser(t)
	await browser.signIn(email)
	return browser
}

describe("authorization request validation", () => {
	test("unknown clients and unregistered redirect URIs are errors, never redirects", async () => {
		const browser = new TestBrowser(t)
		const client = new TestOAuthClient(t)
		const unknown = await client.authorize(browser, { client_id: "nope" })
		expect(unknown.status).toBe(400)
		expect(unknown.body.error.code).toBe("OAUTH_INVALID_CLIENT")

		for (const redirect of [
			"http://localhost:4710/callback/",
			"http://localhost:4710/other",
			"https://evil.example/callback",
		]) {
			const res = await client.authorize(browser, { redirect_uri: redirect })
			expect(res.body.error.code).toBe("OAUTH_INVALID_REDIRECT_URI")
		}
	})

	test("dev clients accept their loopback URI on another port", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t, "e2e_client", "http://localhost:9999/callback")
		const res = await client.authorize(browser)
		expect(res.data.next).toBe("redirect")
		expect(res.data.redirect_to).toStartWith("http://localhost:9999/callback?code=")
	})

	test("protocol errors after the redirect check go back to the client with state", async () => {
		const browser = new TestBrowser(t)
		const client = new TestOAuthClient(t)
		const cases: [Record<string, string>, string][] = [
			[{ response_type: "token" }, "invalid_request"],
			[{ code_challenge_method: "plain" }, "invalid_request"],
			[{ code_challenge: "short" }, "invalid_request"],
			[{ scope: "openid dash" }, "invalid_scope"],
			[{ scope: "" }, "invalid_scope"],
			[{ prompt: "none login" }, "invalid_request"],
			[{ max_age: "-5" }, "invalid_request"],
		]
		for (const [extra, error] of cases) {
			const res = await client.authorize(browser, extra)
			expect(res.status).toBe(200)
			expect(res.data.next).toBe("redirect")
			expect(res.data.request_id).toBeNull()
			const query = client.callback(res.data.redirect_to!)
			expect(query.error).toBe(error)
			expect(query.state).toBe(client.state)
			expect(query.iss).toBe(t.config.issuer)
		}
		const noState = await client.authorize(browser, { state: "" })
		expect(client.callback(noState.data.redirect_to!)).toMatchObject({
			error: "invalid_request",
		})
	})
})

describe("authorization code flow", () => {
	test("sign in, continue, exchange: tokens carry the session claims", async () => {
		const browser = new TestBrowser(t)
		const client = new TestOAuthClient(t)
		const start = await client.authorize(browser)
		expect(start.data).toMatchObject({
			next: "login",
			client: { client_id: "e2e_client", first_party: true },
		})
		expect(start.data.request_id).toStartWith("ar_")
		expect(start.data.scopes.map((scope) => scope.key)).toEqual([
			"openid",
			"profile",
			"email",
			"offline_access",
		])

		await browser.signIn("rider@test.gezcez.com", { requestId: start.data.request_id! })
		const next = await browser.post<{ next: string; redirect_to: string }>(
			`/v1/oauth/authorize/${start.data.request_id}/continue`,
		)
		expect(next.data.next).toBe("redirect")
		const { code, state, iss } = client.callback(next.data.redirect_to)
		expect(state).toBe(client.state)
		expect(iss).toBe(t.config.issuer)

		const token = await client.exchange(code!)
		expect(token.status).toBe(200)
		expect(token.headers.get("cache-control")).toBe("no-store")
		expect(token.body).toMatchObject({
			token_type: "Bearer",
			expires_in: 900,
			scope: "openid profile email offline_access",
		})
		expect(token.body.refresh_token).toBeString()

		const jwks = await t.json<{ keys: object[] }>("/.well-known/jwks.json")
		const verified = await jwtVerify(
			token.body.access_token,
			createLocalJWKSet(jwks.body as never),
			{
				issuer: t.config.issuer,
				audience: "e2e_client",
				typ: "at+jwt",
			},
		)
		const session = await browser.get<{ session: { id: string }; account: { id: string } }>(
			"/v1/account/session",
		)
		expect(verified.payload).toMatchObject({
			sub: session.data.account.id,
			sid: session.data.session.id,
			amr: ["otp"],
		})
		expect(verified.payload.exp! - verified.payload.iat!).toBe(900)
	})

	test("the request is consumed: reloading it afterwards is OAUTH_REQUEST_EXPIRED", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const start = await client.authorize(browser, { prompt: "login" })
		expect(start.data.next).toBe("reauth")
		await browser.signIn("rider@test.gezcez.com")
		const next = await browser.post<{ next: string }>(
			`/v1/oauth/authorize/${start.data.request_id}/continue`,
		)
		expect(next.data.next).toBe("redirect")
		const again = await browser.get(`/v1/oauth/authorize/${start.data.request_id}`)
		expect(again.status).toBe(410)
		expect(again.body.error.code).toBe("OAUTH_REQUEST_EXPIRED")
	})

	test("requests are bound to the browser that created them", async () => {
		const browser = new TestBrowser(t)
		const client = new TestOAuthClient(t)
		const start = await client.authorize(browser)
		const other = new TestBrowser(t)
		const res = await other.get(`/v1/oauth/authorize/${start.data.request_id}`)
		expect(res.status).toBe(404)
		expect(res.body.error.code).toBe("OAUTH_REQUEST_NOT_FOUND")
		const mine = await browser.get<Snapshot>(`/v1/oauth/authorize/${start.data.request_id}`)
		expect(mine.data.next).toBe("login")
	})

	test("a signed-in browser takes the fast path", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const start = await client.authorize(browser)
		expect(start.data.next).toBe("redirect")
		const { code } = client.callback(start.data.redirect_to!)
		const token = await client.exchange(code!)
		expect(token.status).toBe(200)
	})

	test("codes are single use; a replay revokes what the first exchange issued", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(browser)
		const first = await client.exchange(code!)
		expect(first.status).toBe(200)
		const replay = await client.exchange(code!)
		expect(replay.status).toBe(400)
		expect(replay.body.error).toBe("invalid_grant")
		const refresh = await client.refresh(first.body.refresh_token!)
		expect(refresh.body.error).toBe("invalid_grant")
	})

	test("PKCE, redirect URI and client must match, and a failed attempt burns the code", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(browser)
		const wrongVerifier = await client.exchange(code!, {
			code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		})
		expect(wrongVerifier.body.error).toBe("invalid_grant")
		const afterwards = await client.exchange(code!)
		expect(afterwards.body.error).toBe("invalid_grant")

		const second = await client.signInAndAuthorize(browser)
		const wrongRedirect = await client.exchange(second.code!, {
			redirect_uri: "http://localhost:4711/callback",
		})
		expect(wrongRedirect.body.error).toBe("invalid_grant")

		const third = await client.signInAndAuthorize(browser)
		const wrongClient = await client.exchange(third.code!, { client_id: "e2e_third_party" })
		expect(wrongClient.body.error).toBe("invalid_grant")
	})

	test("malformed token requests are RFC errors, not envelopes", async () => {
		const client = new TestOAuthClient(t)
		const noGrant = await client.token({ client_id: "e2e_client" })
		expect(noGrant.body).toMatchObject({ error: "invalid_request" })
		const badGrant = await client.token({ grant_type: "password", client_id: "e2e_client" })
		expect(badGrant.body.error).toBe("unsupported_grant_type")
		const noClient = await client.token({ grant_type: "authorization_code", code: "x" })
		expect(noClient.status).toBe(401)
		expect(noClient.body.error).toBe("invalid_client")
		const json = await client.token(
			{ grant_type: "authorization_code", client_id: "e2e_client" },
			{ form: false },
		)
		expect(json.body.error).toBe("invalid_request")
	})

	test("without offline_access there is no refresh token", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(browser, { scope: "openid profile" })
		const token = await client.exchange(code!)
		expect(token.body.scope).toBe("openid profile")
		expect(token.body.refresh_token).toBeUndefined()
	})
})

describe("prompt, max_age and account choice", () => {
	test("prompt=none answers with error redirects instead of screens", async () => {
		const anonymous = new TestBrowser(t)
		const client = new TestOAuthClient(t)
		const res = await client.authorize(anonymous, { prompt: "none" })
		expect(res.data.next).toBe("redirect")
		expect(client.callback(res.data.redirect_to!)).toMatchObject({
			error: "login_required",
			state: client.state,
		})

		const browser = await signedIn()
		const silent = await client.authorize(browser, { prompt: "none" })
		expect(client.callback(silent.data.redirect_to!).code).toBeString()

		const thirdParty = new TestOAuthClient(t, "e2e_third_party")
		const consent = await thirdParty.authorize(browser, { prompt: "none" })
		expect(thirdParty.callback(consent.data.redirect_to!).error).toBe("consent_required")
	})

	test("max_age older than the session's auth_time needs a re-auth", async () => {
		const browser = await signedIn()
		await Bun.sleep(1100)
		const client = new TestOAuthClient(t)
		const start = await client.authorize(browser, { max_age: "1" })
		expect(start.data.next).toBe("reauth")

		const reauth = await browser.post<{ flow_id: string }>("/v1/account/email/start", {
			intent: "reauth",
		})
		const code = await browser.lastCode("rider@test.gezcez.com")
		await browser.post("/v1/account/email/verify", { flow_id: reauth.data.flow_id, code })
		const next = await browser.post<{ next: string; redirect_to: string }>(
			`/v1/oauth/authorize/${start.data.request_id}/continue`,
		)
		expect(next.data.next).toBe("redirect")
		const token = await client.exchange(client.callback(next.data.redirect_to).code!)
		expect(Date.now() / 1000 - claims(token.body.access_token).auth_time).toBeLessThan(5)
	})

	test("two accounts on one browser lead to the chooser; continue picks one", async () => {
		const browser = await signedIn("admin@test.gezcez.com")
		await browser.signIn("analyst@test.gezcez.com")
		const accounts = await browser.get<{
			accounts: { session_id: string; account: { display_name: string } }[]
		}>("/v1/account/device-accounts")
		const admin = accounts.data.accounts.find(
			(a) => a.account.display_name === "Admin Fixture",
		)!

		const client = new TestOAuthClient(t)
		const start = await client.authorize(browser)
		expect(start.data.next).toBe("choose_account")
		const chosen = await browser.post<{ next: string; redirect_to: string }>(
			`/v1/oauth/authorize/${start.data.request_id}/continue`,
			{ session_id: admin.session_id },
		)
		expect(chosen.data.next).toBe("redirect")
		const token = await client.exchange(client.callback(chosen.data.redirect_to).code!)
		expect(claims(token.body.access_token).sid).toBe(admin.session_id)

		const hinted = await client.authorize(browser, { login_hint: "admin@test.gezcez.com" })
		expect(hinted.data.next).toBe("redirect")
		const select = await client.authorize(browser, { prompt: "select_account" })
		expect(select.data.next).toBe("choose_account")
	})
})

describe("consent for third-party clients", () => {
	test("consent is asked once, remembered, and asked again only for new scopes", async () => {
		const browser = await signedIn("moderator@test.gezcez.com")
		const client = new TestOAuthClient(t, "e2e_third_party")
		const first = await client.authorize(browser, { scope: "openid profile" })
		expect(first.data).toMatchObject({ next: "consent", client: { first_party: false } })
		const approved = await browser.post<{ next: string; redirect_to: string }>(
			`/v1/oauth/authorize/${first.data.request_id}/decision`,
			{ decision: "approve" },
		)
		expect(approved.data.next).toBe("redirect")
		expect(client.callback(approved.data.redirect_to).code).toBeString()

		const again = await client.authorize(browser, { scope: "openid" })
		expect(again.data.next).toBe("redirect")
		const wider = await client.authorize(browser, { scope: "openid email" })
		expect(wider.data.next).toBe("consent")
		const forced = await client.authorize(browser, { scope: "openid", prompt: "consent" })
		expect(forced.data.next).toBe("consent")
	})

	test("deny sends access_denied to the client", async () => {
		const browser = await signedIn("netadmin@test.gezcez.com")
		const client = new TestOAuthClient(t, "e2e_third_party")
		const start = await client.authorize(browser)
		const denied = await browser.post<{ redirect_to: string }>(
			`/v1/oauth/authorize/${start.data.request_id}/decision`,
			{ decision: "deny" },
		)
		expect(client.callback(denied.data.redirect_to)).toMatchObject({
			error: "access_denied",
			state: client.state,
		})
	})

	test("the public app endpoint and the scope list are open", async () => {
		const app = await t.json<{ data: { name: string; scopes: { key: string }[] } }>(
			"/v1/oauth/apps/e2e_third_party",
		)
		expect(app.body.data.scopes.map((scope) => scope.key)).toContain("offline_access")
		const missing = await t.json<{ error: { code: string } }>("/v1/oauth/apps/nope")
		expect(missing.body.error.code).toBe("NOT_FOUND")
		const scopes = await t.json<{ data: { scopes: { key: string }[] } }>("/v1/oauth/scopes")
		expect(scopes.body.data.scopes.map((scope) => scope.key)).toContain("dash")
	})
})

describe("refresh rotation", () => {
	async function tokens() {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(browser)
		const token = await client.exchange(code!)
		return { browser, client, token: token.body }
	}

	test("rotation issues a new refresh token in the same family", async () => {
		const { client, token } = await tokens()
		const rotated = await client.refresh(token.refresh_token!)
		expect(rotated.status).toBe(200)
		expect(rotated.body.refresh_token).not.toBe(token.refresh_token)
		expect(claims(rotated.body.access_token).sid).toBe(claims(token.access_token).sid)
		const next = await client.refresh(rotated.body.refresh_token!)
		expect(next.status).toBe(200)
	})

	test("a retry inside the grace window gets the same successor", async () => {
		const { client, token } = await tokens()
		const [a, b] = await Promise.all([
			client.refresh(token.refresh_token!),
			client.refresh(token.refresh_token!),
		])
		expect(a.status).toBe(200)
		expect(b.status).toBe(200)
		expect(a.body.refresh_token).toBe(b.body.refresh_token!)
		const later = await client.refresh(a.body.refresh_token!)
		expect(later.status).toBe(200)
	})

	test("reuse after the successor was used revokes the family and the session", async () => {
		const { browser, client, token } = await tokens()
		const rotated = await client.refresh(token.refresh_token!)
		const rotatedAgain = await client.refresh(rotated.body.refresh_token!)
		expect(rotatedAgain.status).toBe(200)

		const reuse = await client.refresh(token.refresh_token!)
		expect(reuse.body.error).toBe("invalid_grant")
		const head = await client.refresh(rotatedAgain.body.refresh_token!)
		expect(head.body.error).toBe("invalid_grant")
		const session = await browser.get("/v1/account/session")
		expect(session.body.error.code).toBe("AUTH_SESSION_REQUIRED")
	})

	test("downscoping is allowed, widening is not", async () => {
		const { client, token } = await tokens()
		const narrow = await client.refresh(token.refresh_token!, { scope: "openid" })
		expect(narrow.body.scope).toBe("openid")
		const wide = await client.refresh(narrow.body.refresh_token!, { scope: "openid dash" })
		expect(wide.body.error).toBe("invalid_scope")
	})

	test("revoke ends the family; unknown tokens still get 200", async () => {
		const { client, token } = await tokens()
		const revoked = await client.revoke(token.refresh_token!)
		expect(revoked.status).toBe(200)
		const refresh = await client.refresh(token.refresh_token!)
		expect(refresh.body.error).toBe("invalid_grant")
		expect((await client.revoke("not-a-token")).status).toBe(200)
	})

	test("signing out of the session ends its refresh families", async () => {
		const { browser, client, token } = await tokens()
		const logout = await browser.post<{ signed_out: boolean }>("/v1/oauth/logout", {
			scope: "session",
		})
		expect(logout.data.signed_out).toBe(true)
		const refresh = await client.refresh(token.refresh_token!)
		expect(refresh.body.error).toBe("invalid_grant")
	})
})

describe("grace window disabled", () => {
	test("with REFRESH_GRACE_S=0 any second use is reuse", async () => {
		const strict = await createTestApp({ REFRESH_GRACE_S: "0" })
		try {
			const browser = new TestBrowser(strict)
			await browser.signIn("rider@test.gezcez.com")
			const client = new TestOAuthClient(strict)
			const { code } = await client.signInAndAuthorize(browser)
			const token = await client.exchange(code!)
			const rotated = await client.refresh(token.body.refresh_token!)
			await Bun.sleep(5)
			const reuse = await client.refresh(token.body.refresh_token!)
			expect(reuse.body.error).toBe("invalid_grant")
			const head = await client.refresh(rotated.body.refresh_token!)
			expect(head.body.error).toBe("invalid_grant")
		} finally {
			await strict.close()
		}
	})
})

describe("cookie clients (dashboard)", () => {
	test("the refresh token travels only in gz_rt and refresh works with an empty body", async () => {
		const browser = await signedIn("admin@test.gezcez.com")
		const client = new TestOAuthClient(t, "dashboard-dev", DASH_REDIRECT)
		const { code } = await client.signInAndAuthorize(browser, {
			scope: "openid profile offline_access dash",
		})

		browser.origin = DASH_ORIGIN
		const exchange = await browser.request<never>("POST", "/v1/oauth/token", {
			grant_type: "authorization_code",
			code,
			redirect_uri: DASH_REDIRECT,
			code_verifier: client.pkce.verifier,
			client_id: "dashboard-dev",
		})
		expect(exchange.status).toBe(200)
		const body = exchange.body as unknown as { refresh_token?: string; access_token: string }
		expect(body.refresh_token).toBeUndefined()
		const cookie = exchange.cookies.find((line) => line.startsWith("gz_rt="))!
		expect(cookie).toContain("Path=/v1/oauth")
		expect(cookie).toContain("HttpOnly")
		expect(cookie).toContain("SameSite=Strict")
		expect(cookie).not.toContain("Domain=")
		const first = browser.cookies.get("gz_rt")

		const refresh = await browser.request("POST", "/v1/oauth/token", {})
		expect(refresh.status).toBe(200)
		expect(browser.cookies.get("gz_rt")).not.toBe(first)

		const foreign = new TestBrowser(t, { origin: "https://evil.example" })
		foreign.cookies.set("gz_rt", browser.cookies.get("gz_rt")!)
		const blocked = await foreign.request("POST", "/v1/oauth/token", {})
		expect(blocked.status).toBe(400)
		expect((blocked.body as unknown as { error: string }).error).toBe("invalid_request")

		const revoke = await browser.request("POST", "/v1/oauth/revoke", {})
		expect(revoke.status).toBe(200)
		expect(browser.cookies.has("gz_rt")).toBe(false)
	})
})

describe("confidential clients", () => {
	test("need their secret, by basic auth or in the body", async () => {
		const secret = "s3cret-for-tests-only-0123456789"
		t.app
			.get(DatabaseService)
			.core.insert(appsTable)
			.values({
				client_id: "e2e_confidential",
				name: "Confidential",
				type: "confidential",
				client_secret_hash: createHash("sha256").update(secret).digest("hex"),
				redirect_uris: [E2E_REDIRECT],
				post_logout_redirect_uris: [],
				allowed_scopes: ["openid", "offline_access"],
				first_party: true,
				created_at: new Date(),
			})
			.run()
		const browser = await signedIn()
		const client = new TestOAuthClient(t, "e2e_confidential")
		const scope = { scope: "openid offline_access" }

		const one = await client.signInAndAuthorize(browser, scope)
		const missing = await client.exchange(one.code!)
		expect(missing.status).toBe(401)
		expect(missing.body.error).toBe("invalid_client")

		const two = await client.signInAndAuthorize(browser, scope)
		const wrongSecret = await client.exchange(two.code!, { client_secret: "not-the-secret" })
		expect(wrongSecret.body.error).toBe("invalid_client")
		const viaHeader = await client.token(
			{
				grant_type: "authorization_code",
				code: (await client.signInAndAuthorize(browser, scope)).code!,
				redirect_uri: E2E_REDIRECT,
				code_verifier: client.pkce.verifier,
			},
			{
				headers: {
					authorization: `Basic ${Buffer.from(`e2e_confidential:${secret}`).toString("base64")}`,
				},
			},
		)
		expect(viaHeader.status).toBe(200)

		const viaBody = await client.exchange(
			(await client.signInAndAuthorize(browser, scope)).code!,
			{ client_secret: secret },
		)
		expect(viaBody.status).toBe(200)
		const wrong = await client.refresh(viaBody.body.refresh_token!, { client_secret: "nope" })
		expect(wrong.body.error).toBe("invalid_client")
	})
})

describe("logout", () => {
	test("a registered post-logout URI ends the session and returns the redirect", async () => {
		const browser = await signedIn()
		const res = await browser.post<{ signed_out: boolean; redirect_to: string }>(
			"/v1/oauth/logout",
			{
				scope: "session",
				client_id: "e2e_client",
				post_logout_redirect_uri: "http://localhost:4710/",
				state: "xyz",
			},
		)
		expect(res.data).toEqual({
			signed_out: true,
			redirect_to: "http://localhost:4710/?state=xyz",
		})
		const session = await browser.get("/v1/account/session")
		expect(session.body.error.code).toBe("AUTH_SESSION_REQUIRED")
		const accounts = await browser.get<{ accounts: { signed_out: boolean }[] }>(
			"/v1/account/device-accounts",
		)
		expect(accounts.data.accounts[0]?.signed_out).toBe(true)
	})

	test("an unregistered URI ends nothing, so the UI can ask first", async () => {
		const browser = await signedIn()
		const res = await browser.post<{ signed_out: boolean }>("/v1/oauth/logout", {
			client_id: "e2e_client",
			post_logout_redirect_uri: "https://evil.example/",
		})
		expect(res.data).toEqual({ signed_out: false })
		expect((await browser.get("/v1/account/session")).status).toBe(200)
	})

	test("device scope signs every account on this browser out", async () => {
		const browser = await signedIn("admin@test.gezcez.com")
		await browser.signIn("analyst@test.gezcez.com")
		await browser.post("/v1/oauth/logout", { scope: "device" })
		const accounts = await browser.get<{ accounts: { signed_out: boolean }[] }>(
			"/v1/account/device-accounts",
		)
		expect(accounts.data.accounts.map((a) => a.signed_out)).toEqual([true, true])
	})

	test("logout writes need the CSRF token", async () => {
		const browser = await signedIn()
		browser.csrfToken = "forged"
		const res = await browser.post("/v1/oauth/logout", { scope: "session" })
		expect(res.body.error.code).toBe("CSRF_INVALID")
	})
})
