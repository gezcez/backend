// security.e2e.ts
// Reproductions from the identity and authorization review. Each test asserts the secure or
// intended behaviour. Tests marked `test.failing` are open findings; a fix flips them to `test`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Controller, Get, type ExecutionContext } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { loadConfig } from "@common/config"
import { AuthorizationGuard, UseAuthorization } from "@common/middlewares/authorization.guard"
import { emptyPermissions } from "@common/authorization"
import { DatabaseService } from "@db"
import { refreshTokensTable, sessionsTable, usersTable } from "@schemas/core"
import { createTestApp, type TestApp } from "../helpers/app"
import { TestBrowser } from "../helpers/browser"
import { DashClient, FIXTURE } from "../helpers/dash"
import { claims, TestOAuthClient } from "../helpers/oauth-client"

const DASH_ORIGIN = "http://localhost:5173"

let t: TestApp
let dash: DashClient

beforeAll(async () => {
	t = await createTestApp({ CORS_ORIGINS: DASH_ORIGIN })
	dash = new DashClient(t)
})
afterAll(async () => {
	await t.close()
})

const db = () => t.app.get(DatabaseService).core

async function signedIn(email: string = FIXTURE.rider) {
	const browser = new TestBrowser(t)
	await browser.signIn(email)
	return browser
}

async function reauthByCode(browser: TestBrowser, email: string) {
	const start = await browser.post<{ flow_id: string }>("/v1/account/email/start", {
		intent: "reauth",
	})
	const code = await browser.lastCode(email)
	return browser.post("/v1/account/email/verify", { flow_id: start.data.flow_id, code })
}

describe("F1 config fails open", () => {
	test("production URL without NODE_ENV boots with public dev secrets, console email, no Turnstile", () => {
		// Development defaults (public secrets, console email) only on a loopback API URL.
		expect(() => loadConfig({ PUBLIC_API_URL: "https://api.gezcez.com" })).toThrow()
	})

	test("STAGING_TEST_OTP is accepted on production with a URL variant", () => {
		expect(() =>
			loadConfig({
				NODE_ENV: "production",
				PUBLIC_API_URL: "https://api.gezcez.com:443",
				KEY_ENCRYPTION_SECRET: "x".repeat(32),
				SEAL_SECRET: "x".repeat(32),
				CODE_PEPPER: "x".repeat(32),
				CSRF_SECRET: "x".repeat(32),
				STAGING_TEST_OTP: "123456",
			}),
		).toThrow()
	})

	test("production boots without TURNSTILE_SECRET and EMAIL_TRANSPORT (codes go to stdout)", () => {
		expect(() =>
			loadConfig({
				NODE_ENV: "production",
				PUBLIC_API_URL: "https://api.gezcez.com",
				KEY_ENCRYPTION_SECRET: "x".repeat(32),
				SEAL_SECRET: "x".repeat(32),
				CODE_PEPPER: "x".repeat(32),
				CSRF_SECRET: "x".repeat(32),
			}),
		).toThrow()
	})
})

describe("F2 every CORS origin is a full identity-UI origin", () => {
	test("the dashboard origin can read the CSRF token and write account settings", async () => {
		const browser = await signedIn()
		browser.origin = DASH_ORIGIN
		browser.csrfToken = undefined
		const csrf = await browser.get<{ token: string }>("/v1/account/csrf")
		// credentialed CORS read of the CSRF token from the dashboard origin
		browser.csrfToken = csrf.data.token
		const write = await browser.request("PATCH", "/v1/account/profile", {
			display_name: "pwned-from-dash",
		})
		expect(write.status).toBe(403) // plan 6.1.0: account writes only from oauth.gezcez.com
	})
})

describe("F2 cookie routes and CORS per route group", () => {
	test("every cookie write refuses the CORS origins other than the identity UI", async () => {
		const browser = await signedIn()
		await browser.csrf()
		browser.origin = DASH_ORIGIN
		const doc = await t.json<{ paths: Record<string, Record<string, unknown>> }>(
			"/openapi.json",
		)
		const writes = Object.entries(doc.body.paths)
			.filter(([path]) => /^\/v1\/(account\/|oauth\/(authorize|logout))/.test(path))
			.flatMap(([path, operations]) =>
				Object.keys(operations)
					.filter((method) => ["post", "put", "patch", "delete"].includes(method))
					.map((method) => [method.toUpperCase(), path.replace(/\{[^}]+\}/g, "x")]),
			)
		expect(writes.length).toBeGreaterThan(15)
		for (const [method, path] of writes) {
			const res = await browser.request(method!, path!, {})
			expect([path, res.body.error?.code]).toEqual([path, "CSRF_INVALID"])
		}
	})

	test("credentialed CORS: oauth UI on identity routes, dashboard on gz_rt routes only", async () => {
		const preflight = (path: string, origin: string) =>
			t.fetch(path, {
				method: "OPTIONS",
				headers: { origin, "access-control-request-method": "POST" },
			})
		const oauthUi = t.config.oauthUiUrl
		const account = await preflight("/v1/account/profile", oauthUi)
		expect(account.headers.get("access-control-allow-origin")).toBe(oauthUi)
		expect(account.headers.get("access-control-allow-credentials")).toBe("true")
		const accountFromDash = await preflight("/v1/account/csrf", DASH_ORIGIN)
		expect(accountFromDash.headers.get("access-control-allow-origin")).toBeNull()
		const token = await preflight("/v1/oauth/token", DASH_ORIGIN)
		expect(token.headers.get("access-control-allow-credentials")).toBe("true")
		const tokenFromOauthUi = await preflight("/v1/oauth/token", oauthUi)
		expect(tokenFromOauthUi.headers.get("access-control-allow-credentials")).toBeNull()
		const bearer = await t.fetch("/v1/system/version", { headers: { origin: DASH_ORIGIN } })
		expect(bearer.headers.get("access-control-allow-origin")).toBe(DASH_ORIGIN)
		expect(bearer.headers.get("access-control-allow-credentials")).toBeNull()
		expect(bearer.headers.get("vary")).toContain("Origin")
	})
})

describe("F2c a script on the dashboard origin mints long-lived tokens for another client", () => {
	test("POST /v1/oauth/authorize from the dash origin returns a code in readable JSON", async () => {
		const browser = await signedIn()
		browser.origin = DASH_ORIGIN
		browser.csrfToken = undefined
		await browser.csrf() // readable cross-origin, see F2
		const attacker = new TestOAuthClient(t, "e2e_client") // attacker-chosen PKCE
		const start = await attacker.authorize(browser)
		expect(start.status).toBe(403) // expected CSRF_INVALID for a non identity-UI origin
		expect(start.body.error.code).toBe("CSRF_INVALID")
	})
})

describe("F2b the oauth UI origin can spend the dashboard's gz_rt", () => {
	test("cookie refresh from https origin of the identity UI returns a dash token, readable by CORS", async () => {
		const browser = await signedIn(FIXTURE.admin)
		const client = new TestOAuthClient(t, "dashboard-dev", `${DASH_ORIGIN}/auth/callback`)
		const { code } = await client.signInAndAuthorize(browser, {
			scope: "openid offline_access dash",
		})
		browser.origin = DASH_ORIGIN
		await browser.request("POST", "/v1/oauth/token", {
			grant_type: "authorization_code",
			code,
			redirect_uri: `${DASH_ORIGIN}/auth/callback`,
			code_verifier: client.pkce.verifier,
			client_id: "dashboard-dev",
		})
		browser.origin = t.config.oauthUiUrl // identity UI origin, not the dashboard
		const refresh = await browser.request("POST", "/v1/oauth/token", {})
		expect(refresh.status).toBe(400) // plan 6.1.0: gz_rt only from dash.gezcez.com
	})
})

describe("F3 max_age=0 never completes", () => {
	test("after a fresh re-auth, continue still answers reauth", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const start = await client.authorize(browser, { max_age: "0" })
		expect(start.data.next).toBe("reauth")
		await reauthByCode(browser, FIXTURE.rider)
		await Bun.sleep(5)
		const next = await browser.post<{ next: string }>(
			`/v1/oauth/authorize/${start.data.request_id}/continue`,
		)
		expect(next.data.next).toBe("redirect")
	})
})

describe("F4 refresh families outlive their SSO session", () => {
	test("a refresh token keeps working after the session expired (not revoked)", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(browser)
		const token = await client.exchange(code!)
		const sid = claims(token.body.access_token).sid
		const past = new Date(Date.now() - 1000)
		db()
			.update(sessionsTable)
			.set({ expires_at: past, absolute_expires_at: past })
			.where(eq(sessionsTable.id, sid))
			.run()
		const session = await browser.get("/v1/account/session")
		expect(session.status).toBe(401) // the SSO session is dead
		const refresh = await client.refresh(token.body.refresh_token!)
		expect(refresh.body.error).toBe("invalid_grant") // actual: 200, new tokens for a dead session
	})

	test("a refresh never outlives the session's absolute expiry and keeps the session alive", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(browser)
		const token = await client.exchange(code!)
		const sid = claims(token.body.access_token).sid
		const absolute = new Date(Date.now() + 3_600_000)
		const stale = new Date(Date.now() - 3_600_000)
		db()
			.update(sessionsTable)
			.set({ absolute_expires_at: absolute, expires_at: absolute, last_seen_at: stale })
			.where(eq(sessionsTable.id, sid))
			.run()
		const refresh = await client.refresh(token.body.refresh_token!)
		expect(refresh.status).toBe(200)
		const rows = db()
			.select()
			.from(refreshTokensTable)
			.where(eq(refreshTokensTable.session_id, sid))
			.all()
		const head = rows.find((row) => row.replaced_by === null)!
		expect(head.expires_at.getTime()).toBeLessThanOrEqual(absolute.getTime())
		const session = db().select().from(sessionsTable).where(eq(sessionsTable.id, sid)).get()!
		expect(session.last_seen_at.getTime()).toBeGreaterThan(stale.getTime())
	})
})

describe("F5 email-change oracle runs before Turnstile and rate limits", () => {
	test("EMAIL_TAKEN answers without consuming the email-code-send limit", async () => {
		const strict = await createTestApp({ RATE_LIMIT_SCALE: "1" })
		try {
			const browser = new TestBrowser(strict)
			await browser.signIn("probe@example.com")
			const codes: string[] = []
			for (let i = 0; i < 12; i++) {
				const res = await browser.post("/v1/account/email/change", {
					new_email: FIXTURE.admin,
				})
				codes.push(res.body.ok ? "ok" : res.body.error.code)
			}
			// 12 probes of a taken address; the per-email limit is 5/h. Expected a 429 at some point.
			expect(codes).toContain("RATE_LIMITED")
			expect(codes.filter((code) => code === "EMAIL_TAKEN").length).toBeLessThanOrEqual(5)
		} finally {
			await strict.close()
		}
	})
})

describe("F6 admin session revocation has no level check", () => {
	test("admin (900) can sign root out everywhere", async () => {
		const root = dash.publicId(FIXTURE.root)
		await dash.token(FIXTURE.root) // root has a live session
		const res = await dash.call(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${root}/sessions/revoke-all`,
			{
				reason: "review",
			},
		)
		expect(res.status).toBe(403) // moderation has a level rule; session revocation does not
	})

	test("admins still end sessions of lower levels and their own", async () => {
		const moderator = dash.publicId(FIXTURE.moderator)
		await dash.token(FIXTURE.moderator)
		const lower = await dash.call(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${moderator}/sessions/revoke-all`,
			{ reason: "review" },
		)
		expect(lower.status).toBe(200)
		dash.forget(FIXTURE.moderator)
		const self = await dash.call(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${dash.publicId(FIXTURE.admin)}/sessions/revoke-all`,
			{ reason: "lost laptop" },
		)
		expect(self.status).toBe(200)
		dash.forget(FIXTURE.admin)
	})

	test("a ban placed by an admin cannot be lifted by a moderator", async () => {
		const email = "banned-by-admin@example.com"
		await signedIn(email)
		const user = db().select().from(usersTable).where(eq(usersTable.email, email)).get()!
		const path = `/v1/dash/users/${user.public_id}`
		const ban = await dash.call(FIXTURE.admin, "POST", `${path}/ban`, {
			public_reason: "spam spam",
			duration: "1d",
		})
		expect(ban.status).toBe(200)
		const moderator = await dash.call(FIXTURE.moderator, "POST", `${path}/unban`, {
			reason: "mistake",
		})
		expect(moderator.body.error.code).toBe("ROLE_LEVEL_TOO_LOW")
		const admin = await dash.call(FIXTURE.admin, "POST", `${path}/unban`, { reason: "mistake" })
		expect(admin.status).toBe(200)
	})
})

describe("F7 re-auth keeps the same session token", () => {
	test("the session cookie is not rotated on step-up (plan 6.1.0)", async () => {
		const browser = await signedIn()
		const before = browser.cookies.get("__Host-gz_session")
		await Bun.sleep(5)
		await reauthByCode(browser, FIXTURE.rider)
		expect(browser.cookies.get("__Host-gz_session")).not.toBe(before)
	})

	test("the rotated cookie keeps working and the old value is dead", async () => {
		const browser = await signedIn()
		const before = browser.cookies.get("__Host-gz_session")!
		await reauthByCode(browser, FIXTURE.rider)
		expect((await browser.get("/v1/account/session")).status).toBe(200)
		browser.cookies.set("__Host-gz_session", before)
		expect((await browser.get("/v1/account/session")).status).toBe(401)
	})
})

describe("F8 ban erases pending deletion", () => {
	test("banning a pending_deletion account cancels the deletion state", async () => {
		const target = await signedIn("deleting@example.com")
		void target
		const user = db()
			.select()
			.from(usersTable)
			.where(eq(usersTable.email, "deleting@example.com"))
			.get()!
		const due = new Date(Date.now() + 14 * 86_400_000)
		db()
			.update(usersTable)
			.set({ status: "pending_deletion", deletion_due_at: due })
			.where(eq(usersTable.id, user.id))
			.run()
		const ban = await dash.call(
			FIXTURE.moderator,
			"POST",
			`/v1/dash/users/${user.public_id}/ban`,
			{
				public_reason: "spam spam",
				duration: "1d",
			},
		)
		expect(ban.status).toBe(200)
		const unban = await dash.call(
			FIXTURE.moderator,
			"POST",
			`/v1/dash/users/${user.public_id}/unban`,
			{
				reason: "mistake",
			},
		)
		expect(unban.status).toBe(200)
		const after = db().select().from(usersTable).where(eq(usersTable.id, user.id)).get()!
		expect(after.status).toBe("pending_deletion") // actual: active, deletion silently cancelled
	})

	test("an expired ban on a pending_deletion account resumes the deletion at sign-in", async () => {
		const email = "deleting-expired@example.com"
		await signedIn(email)
		const user = db().select().from(usersTable).where(eq(usersTable.email, email)).get()!
		const due = new Date(Date.now() + 14 * 86_400_000)
		db()
			.update(usersTable)
			.set({ status: "pending_deletion", deletion_due_at: due })
			.where(eq(usersTable.id, user.id))
			.run()
		await dash.call(FIXTURE.moderator, "POST", `/v1/dash/users/${user.public_id}/ban`, {
			public_reason: "spam spam",
			duration: "1d",
		})
		db()
			.update(usersTable)
			.set({ banned_until: new Date(Date.now() - 1000) })
			.where(eq(usersTable.id, user.id))
			.run()
		const detail = await dash.call<{ status: string }>(
			FIXTURE.moderator,
			"GET",
			`/v1/dash/users/${user.public_id}`,
		)
		expect(detail.body.data.status).toBe("pending_deletion")
		const browser = new TestBrowser(t)
		await expect(browser.signIn(email)).rejects.toThrow("USER_PENDING_DELETION")
		const after = db().select().from(usersTable).where(eq(usersTable.id, user.id)).get()!
		expect(after).toMatchObject({ status: "pending_deletion", banned_until: null })
		expect(after.deletion_due_at?.getTime()).toBe(due.getTime())
	})

	test("an active account returns to active, and deleted accounts are not found for a ban", async () => {
		const email = "banned-plain@example.com"
		await signedIn(email)
		const user = db().select().from(usersTable).where(eq(usersTable.email, email)).get()!
		const path = `/v1/dash/users/${user.public_id}`
		await dash.call(FIXTURE.moderator, "POST", `${path}/ban`, {
			public_reason: "spam spam",
			duration: "1d",
		})
		await dash.call(FIXTURE.moderator, "POST", `${path}/unban`, { reason: "mistake" })
		expect(db().select().from(usersTable).where(eq(usersTable.id, user.id)).get()!.status).toBe(
			"active",
		)
		db().update(usersTable).set({ status: "deleted" }).where(eq(usersTable.id, user.id)).run()
		const ban = await dash.call(FIXTURE.moderator, "POST", `${path}/ban`, {
			public_reason: "spam spam",
			duration: "1d",
		})
		expect(ban.body.error.code).toBe("NOT_FOUND")
		expect(db().select().from(usersTable).where(eq(usersTable.id, user.id)).get()!.status).toBe(
			"deleted",
		)
	})
})

describe("F9 reset token race", () => {
	test("one reset_token used twice concurrently sets two passwords and signs in twice", async () => {
		const email = "resetrace@example.com"
		const browser = await signedIn(email)
		await browser.request("PUT", "/v1/account/password", {
			new_password: "correct horse battery 1",
		})
		const fresh = new TestBrowser(t)
		await fresh.csrf()
		const start = await fresh.post<{ flow_id: string }>("/v1/account/email/start", {
			email,
			intent: "reset",
			locale: "en",
		})
		const code = await fresh.lastCode(email)
		const verify = await fresh.post<{ reset_token: string }>("/v1/account/email/verify", {
			flow_id: start.data.flow_id,
			code,
		})
		const token = verify.data.reset_token
		const [a, b] = await Promise.all([
			fresh.post("/v1/account/password/reset", {
				reset_token: token,
				new_password: "first new password A",
			}),
			fresh.post("/v1/account/password/reset", {
				reset_token: token,
				new_password: "second new password B",
			}),
		])
		expect([a.status, b.status].filter((s) => s === 200).length).toBe(1)
	})
})

describe("F10 class-level @UseAuthorization is silently ignored", () => {
	test("AuthorizationGuard allows a request when the metadata sits on the class", () => {
		@UseAuthorization({ permission: "users.read", scope: "global", description: "x" })
		@Controller("dash/x")
		class X {
			@Get()
			list() {
				return 1
			}
		}
		const guard = new AuthorizationGuard(new Reflector(), {
			forUser: () => emptyPermissions(),
			resolveNetwork: () => undefined,
		})
		const context = {
			getHandler: () => X.prototype.list,
			getClass: () => X,
			switchToHttp: () => ({ getRequest: () => ({ auth: { userId: 999 }, params: {} }) }),
		} as unknown as ExecutionContext
		let allowed: boolean
		try {
			allowed = guard.canActivate(context)
		} catch {
			allowed = false
		}
		expect(allowed).toBe(false)
	})

	test("class-level metadata is enforced and a route the user may use passes", () => {
		@UseAuthorization({ permission: "users.read", scope: "global", description: "x" })
		@Controller("dash/y")
		class Y {
			@Get()
			list() {
				return 1
			}
		}
		const allowed = emptyPermissions()
		allowed.global.add("users.read")
		const guard = new AuthorizationGuard(new Reflector(), {
			forUser: () => allowed,
			resolveNetwork: () => undefined,
		})
		const context = {
			getHandler: () => Y.prototype.list,
			getClass: () => Y,
			switchToHttp: () => ({ getRequest: () => ({ auth: { userId: 1 }, params: {} }) }),
		} as unknown as ExecutionContext
		expect(guard.canActivate(context)).toBe(true)
	})
})

describe("F11 distributed code guessing is capped per address and per network", () => {
	test("20 wrong codes a day stop every code for the address and mail its owner", async () => {
		const email = "capped@example.com"
		await signedIn(email)
		const browser = new TestBrowser(t)
		await browser.csrf()
		const start = () =>
			browser.post<{ flow_id: string }>("/v1/account/email/start", {
				email,
				intent: "signin",
				locale: "en",
			})
		for (let flow = 0; flow < 4; flow++) {
			const { data } = await start()
			const real = await browser.lastCode(email)
			const wrong = String((Number(real) + 1) % 1_000_000).padStart(6, "0")
			for (let i = 0; i < 5; i++)
				await browser.post("/v1/account/email/verify", {
					flow_id: data.flow_id,
					code: wrong,
				})
		}
		const fresh = await start()
		const code = await browser.lastCode(email)
		const last = await browser.post("/v1/account/email/verify", {
			flow_id: fresh.data.flow_id,
			code,
		})
		expect(last.body.error.code).toBe("AUTH_CODE_ATTEMPTS")
		const mailbox = await t.json<{ data: { messages: { template: string }[] } }>(
			`/v1/__test/mailbox?to=${encodeURIComponent(email)}`,
		)
		expect(mailbox.body.data.messages.map((m) => m.template)).toContain("codes_locked")
	})
})

describe("probes that held (kept as regression checks)", () => {
	test("20 concurrent refreshes with one token all get the same successor, family survives", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(browser)
		const token = await client.exchange(code!)
		const results = await Promise.all(
			Array.from({ length: 20 }, () => client.refresh(token.body.refresh_token!)),
		)
		expect(results.every((r) => r.status === 200)).toBe(true)
		expect(new Set(results.map((r) => r.body.refresh_token)).size).toBe(1)
		const next = await client.refresh(results[0]!.body.refresh_token!)
		expect(next.status).toBe(200)
	})

	test("10 concurrent code exchanges: exactly one wins", async () => {
		const browser = await signedIn()
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(browser)
		const results = await Promise.all(Array.from({ length: 10 }, () => client.exchange(code!)))
		expect(results.filter((r) => r.status === 200).length).toBe(1)
	})

	test("concurrent wrong codes cannot exceed 5 attempts", async () => {
		const browser = new TestBrowser(t)
		await browser.csrf()
		const start = await browser.post<{ flow_id: string }>("/v1/account/email/start", {
			email: "bruteforce@example.com",
			intent: "signin",
			locale: "en",
		})
		const real = await browser.lastCode("bruteforce@example.com")
		const guesses = Array.from({ length: 40 }, (_, i) =>
			String((Number(real) + 1 + i) % 1_000_000).padStart(6, "0"),
		)
		await Promise.all(
			guesses.map((code) =>
				browser.post("/v1/account/email/verify", { flow_id: start.data.flow_id, code }),
			),
		)
		const last = await browser.post("/v1/account/email/verify", {
			flow_id: start.data.flow_id,
			code: real,
		})
		expect(last.body.error?.code).toBe("AUTH_CODE_ATTEMPTS")
	})

	test("JWT alg confusion and unsigned tokens are refused", async () => {
		const { accessToken } = await (
			await import("../helpers/oauth-client")
		).accessTokenFor(t, FIXTURE.rider, {
			clientId: "e2e_client",
			scope: "openid",
		})
		const [h, p] = accessToken.split(".")
		const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url")}.${p}.`
		const hs = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "at+jwt" })).toString("base64url")}.${p}.${h}`
		for (const bad of [none, hs]) {
			const res = await t.json<{ error: { code: string } }>("/v1/me", {
				headers: { authorization: `Bearer ${bad}` },
			})
			expect(res.status).toBe(401)
		}
	})
})
