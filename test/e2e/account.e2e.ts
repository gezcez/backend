import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { DatabaseService } from "@db"
import { moderationActionsTable, sessionsTable, usersTable } from "@schemas/core"
import { AccountRepository } from "@services/account/account.repository"
import { createTestApp, type TestApp } from "../helpers/app"
import { TestBrowser } from "../helpers/browser"

let t: TestApp

beforeAll(async () => {
	t = await createTestApp()
})
afterAll(async () => {
	await t.close()
})

const db = () => t.app.get(DatabaseService).core

async function startFlow(browser: TestBrowser, email: string, intent = "signin") {
	if (!browser.csrfToken) await browser.csrf()
	const res = await browser.post<{ flow_id: string }>("/v1/account/email/start", {
		email,
		intent,
		locale: "en",
	})
	expect(res.status).toBe(202)
	return res.data.flow_id
}

describe("cookies and CSRF", () => {
	test("GET /v1/account/csrf issues the device cookie with host-only attributes", async () => {
		const browser = new TestBrowser(t)
		const res = await browser.get<{ token: string }>("/v1/account/csrf")
		expect(res.status).toBe(200)
		expect(res.data.token.length).toBeGreaterThan(20)
		const cookie = res.cookies.find((line) => line.startsWith("__Host-gz_device="))!
		expect(cookie).toContain("HttpOnly")
		expect(cookie).toContain("Secure")
		expect(cookie).toContain("SameSite=Lax")
		expect(cookie).toContain("Path=/")
		expect(cookie).not.toContain("Domain=")
	})

	test("writes without an allowed Origin are rejected", async () => {
		const browser = new TestBrowser(t, { origin: "https://evil.example" })
		await browser.csrf()
		const res = await browser.post("/v1/account/email/start", {
			email: "a@example.com",
			intent: "signin",
		})
		expect(res.status).toBe(403)
		expect(res.body.error.code).toBe("CSRF_INVALID")

		const noOrigin = await t.json<{ error: { code: string } }>("/v1/account/email/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "a@example.com", intent: "signin" }),
		})
		expect(noOrigin.body.error.code).toBe("CSRF_INVALID")
	})

	test("writes without the CSRF token, or with another device's token, are rejected", async () => {
		const browser = new TestBrowser(t)
		await browser.get("/v1/account/csrf")
		const res = await browser.post("/v1/account/email/start", {
			email: "a@example.com",
			intent: "signin",
		})
		expect(res.body.error.code).toBe("CSRF_INVALID")

		const other = new TestBrowser(t)
		browser.csrfToken = await other.csrf()
		const stolen = await browser.post("/v1/account/email/start", {
			email: "a@example.com",
			intent: "signin",
		})
		expect(stolen.body.error.code).toBe("CSRF_INVALID")
	})

	test("non-JSON bodies are rejected on cookie routes", async () => {
		const browser = new TestBrowser(t)
		await browser.csrf()
		// A simple (CORS-preflight-free) form post from another site would look like this.
		const res = await browser.request(
			"POST",
			"/v1/account/email/start",
			"email=a@example.com",
			{
				"content-type": "text/plain",
			},
		)
		expect(res.status).toBe(403)
		expect(res.body.error.code).toBe("CSRF_INVALID")
	})

	test("GET /v1/account/session needs a session", async () => {
		const browser = new TestBrowser(t)
		const res = await browser.get("/v1/account/session")
		expect(res.status).toBe(401)
		expect(res.body.error.code).toBe("AUTH_SESSION_REQUIRED")
	})
})

describe("email code sign-up and sign-in", () => {
	test("a new address signs up: needs_profile, then signup/complete creates the account", async () => {
		const browser = new TestBrowser(t)
		const flowId = await startFlow(browser, "New.Rider@Example.com")
		const mail = await t.json<{ data: { messages: { template: string; code: string }[] } }>(
			"/v1/__test/mailbox?to=new.rider@example.com",
		)
		expect(mail.body.data.messages.at(-1)?.template).toBe("signup_code")

		const verify = await browser.post<{ status: string; profile_token: string; email: string }>(
			"/v1/account/email/verify",
			{ flow_id: flowId, code: mail.body.data.messages.at(-1)!.code },
		)
		expect(verify.status).toBe(200)
		expect(verify.data.status).toBe("needs_profile")
		expect(verify.data.email).toBe("new.rider@example.com")
		expect(browser.cookies.has("__Host-gz_session")).toBe(false)

		const complete = await browser.post<{
			account: { id: string; display_name: string; email: string }
		}>("/v1/account/signup/complete", {
			profile_token: verify.data.profile_token,
			display_name: "Yeni Yolcu",
			tos_version: "2026-10",
			privacy_version: "2026-10",
			locale: "tr",
		})
		expect(complete.status).toBe(200)
		expect(complete.data.account).toMatchObject({
			display_name: "Yeni Yolcu",
			email: "new.rider@example.com",
			email_masked: "n***@example.com",
			avatar_initials: "YY",
			locale: "tr",
		})
		const sessionCookie = complete.cookies.find((line) =>
			line.startsWith("__Host-gz_session="),
		)!
		expect(sessionCookie).toContain("HttpOnly")
		expect(sessionCookie).toContain("SameSite=Lax")

		const session = await browser.get<{ account: { id: string }; session: { amr: string[] } }>(
			"/v1/account/session",
		)
		expect(session.status).toBe(200)
		expect(session.data.account.id).toBe(complete.data.account.id)
		expect(session.data.session.amr).toEqual(["otp"])

		// The profile token cannot create a second account.
		const again = await browser.post("/v1/account/signup/complete", {
			profile_token: verify.data.profile_token,
			display_name: "Twice",
			tos_version: "2026-10",
			privacy_version: "2026-10",
			locale: "tr",
		})
		expect(again.body.error.code).toBe("EMAIL_TAKEN")
	})

	test("known and unknown addresses get the same answer", async () => {
		const browser = new TestBrowser(t)
		await browser.csrf()
		const known = await browser.post<Record<string, unknown>>("/v1/account/email/start", {
			email: "rider@test.gezcez.com",
			intent: "signup",
		})
		const unknown = await browser.post<Record<string, unknown>>("/v1/account/email/start", {
			email: "nobody-here@example.com",
			intent: "signin",
		})
		expect(known.status).toBe(202)
		expect(unknown.status).toBe(202)
		expect(Object.keys(known.data).sort()).toEqual(Object.keys(unknown.data).sort())
		expect(known.data.code_length).toBe(6)
		// A known address always gets a sign-in code, whatever the button said.
		const mail = await t.json<{ data: { messages: { template: string }[] } }>(
			"/v1/__test/mailbox?to=rider@test.gezcez.com",
		)
		expect(mail.body.data.messages.at(-1)?.template).toBe("signin_code")
	})

	test("an existing account signs in and the code is single use", async () => {
		const browser = new TestBrowser(t)
		const flowId = await startFlow(browser, "rider@test.gezcez.com")
		const code = await browser.lastCode("rider@test.gezcez.com")
		const verify = await browser.post<{ status: string; account: { display_name: string } }>(
			"/v1/account/email/verify",
			{ flow_id: flowId, code },
		)
		expect(verify.status).toBe(200)
		expect(verify.data.status).toBe("signed_in")
		expect(verify.data.account.display_name).toBe("Rider Fixture")
		expect(browser.cookies.has("__Host-gz_session")).toBe(true)

		const replay = await browser.post("/v1/account/email/verify", { flow_id: flowId, code })
		expect(replay.body.error.code).toBe("AUTH_CODE_EXPIRED")
	})

	test("wrong codes count down and lock the flow after five attempts", async () => {
		const browser = new TestBrowser(t)
		const flowId = await startFlow(browser, "attempts@example.com")
		const code = await browser.lastCode("attempts@example.com")
		const wrong = code === "000000" ? "111111" : "000000"
		for (let left = 4; left >= 1; left--) {
			const res = await browser.post("/v1/account/email/verify", {
				flow_id: flowId,
				code: wrong,
			})
			expect(res.status).toBe(400)
			expect(res.body.error.code).toBe("AUTH_CODE_INVALID")
			expect(res.body.error.details?.attempts_left).toBe(left)
		}
		const fifth = await browser.post("/v1/account/email/verify", {
			flow_id: flowId,
			code: wrong,
		})
		expect(fifth.body.error.code).toBe("AUTH_CODE_ATTEMPTS")
		const correct = await browser.post("/v1/account/email/verify", { flow_id: flowId, code })
		expect(correct.body.error.code).toBe("AUTH_CODE_ATTEMPTS")
	})

	test("expired codes are refused", async () => {
		const browser = new TestBrowser(t)
		const flowId = await startFlow(browser, "late@example.com")
		const code = await browser.lastCode("late@example.com")
		t.app.get(AccountRepository).setFlowExpiry(flowId, new Date(Date.now() - 1000))
		const res = await browser.post("/v1/account/email/verify", { flow_id: flowId, code })
		expect(res.body.error.code).toBe("AUTH_CODE_EXPIRED")
	})

	test("resend waits 30 s, then replaces the code", async () => {
		const browser = new TestBrowser(t)
		const flowId = await startFlow(browser, "resend@example.com")
		const first = await browser.lastCode("resend@example.com")
		const early = await browser.post("/v1/account/email/resend", { flow_id: flowId })
		expect(early.status).toBe(429)
		expect(early.body.error.code).toBe("RATE_LIMITED")
		expect(early.body.error.details?.retry_after).toBeGreaterThan(0)

		t.app
			.get(AccountRepository)
			.setFlowExpiry(flowId, new Date(Date.now() + 600_000), new Date(Date.now() - 1000))
		const resent = await browser.post<{ resend_available_at: string }>(
			"/v1/account/email/resend",
			{ flow_id: flowId },
		)
		expect(resent.status).toBe(200)
		const second = await browser.lastCode("resend@example.com")
		if (second !== first) {
			const old = await browser.post("/v1/account/email/verify", {
				flow_id: flowId,
				code: first,
			})
			expect(old.body.error.code).toBe("AUTH_CODE_INVALID")
		}
		const ok = await browser.post<{ status: string }>("/v1/account/email/verify", {
			flow_id: flowId,
			code: second,
		})
		expect(ok.data.status).toBe("needs_profile")
	})

	test("validation errors list the fields", async () => {
		const browser = new TestBrowser(t)
		await browser.csrf()
		const res = await browser.post("/v1/account/email/start", {
			email: "not-an-email",
			intent: "signin",
		})
		expect(res.status).toBe(400)
		expect(res.body.error.code).toBe("VALIDATION_FAILED")
		expect(JSON.stringify(res.body.error.details)).toContain("email")
	})

	test("a banned account learns about the ban only after proving ownership", async () => {
		const user = db()
			.insert(usersTable)
			.values({
				public_id: "01JBANNEDUSER000000000000",
				email: "banned@example.com",
				display_name: "Banned",
				status: "banned",
			})
			.returning()
			.get()
		db()
			.insert(moderationActionsTable)
			.values({
				target_user_id: user.id,
				action: "ban",
				public_reason: "Spam",
				created_at: new Date(),
			})
			.run()
		const browser = new TestBrowser(t)
		const flowId = await startFlow(browser, "banned@example.com")
		const code = await browser.lastCode("banned@example.com")
		const res = await browser.post("/v1/account/email/verify", { flow_id: flowId, code })
		expect(res.status).toBe(403)
		expect(res.body.error.code).toBe("USER_BANNED")
		expect(res.body.error.details?.public_reason).toBe("Spam")
		expect(browser.cookies.has("__Host-gz_session")).toBe(false)
	})

	test("an expired ban lifts itself at sign-in", async () => {
		db()
			.insert(usersTable)
			.values({
				public_id: "01JEXPIREDBAN000000000000",
				email: "was-banned@example.com",
				display_name: "Was Banned",
				status: "banned",
				banned_until: new Date(Date.now() - 1000),
			})
			.run()
		const browser = new TestBrowser(t)
		const res = await browser.signIn("was-banned@example.com")
		expect(res.data).toMatchObject({ status: "signed_in" })
		const row = db()
			.select()
			.from(usersTable)
			.where(eq(usersTable.email, "was-banned@example.com"))
			.get()
		expect(row?.status).toBe("active")
	})

	test("reset without a password sends a notice and the flow never verifies", async () => {
		const browser = new TestBrowser(t)
		const flowId = await startFlow(browser, "rider@test.gezcez.com", "reset")
		const mail = await t.json<{ data: { messages: { template: string; code?: string }[] } }>(
			"/v1/__test/mailbox?to=rider@test.gezcez.com",
		)
		expect(mail.body.data.messages.at(-1)).toMatchObject({ template: "reset_unavailable" })
		expect(mail.body.data.messages.at(-1)?.code).toBeUndefined()
		const res = await browser.post("/v1/account/email/verify", {
			flow_id: flowId,
			code: "123456",
		})
		expect(res.body.error.code).toBe("AUTH_CODE_INVALID")
	})
})

describe("sessions on a device", () => {
	test("the session cookie only works together with its device cookie", async () => {
		const browser = new TestBrowser(t)
		await browser.signIn("moderator@test.gezcez.com")
		const thief = new TestBrowser(t)
		thief.cookies.set("__Host-gz_session", browser.cookies.get("__Host-gz_session")!)
		const res = await thief.get("/v1/account/session")
		expect(res.body.error.code).toBe("AUTH_SESSION_REQUIRED")
	})

	test("device accounts list both users and switching changes the active session", async () => {
		const browser = new TestBrowser(t)
		await browser.signIn("admin@test.gezcez.com")
		await browser.signIn("analyst@test.gezcez.com")
		const list = await browser.get<{
			accounts: {
				session_id: string
				account: { display_name: string; email?: string }
				active: boolean
				signed_out: boolean
			}[]
		}>("/v1/account/device-accounts")
		expect(
			list.data.accounts.map((a) => [a.account.display_name, a.active, a.signed_out]),
		).toEqual([
			["Analyst Fixture", true, false],
			["Admin Fixture", false, false],
		])
		// Only the active account shows its full address.
		expect(list.data.accounts[1]?.account.email).toBeUndefined()

		const admin = list.data.accounts[1]!
		const switched = await browser.post<{ account: { display_name: string } }>(
			"/v1/account/session/switch",
			{
				session_id: admin.session_id,
			},
		)
		expect(switched.status).toBe(200)
		expect(switched.data.account.display_name).toBe("Admin Fixture")
		const session = await browser.get<{ account: { display_name: string } }>(
			"/v1/account/session",
		)
		expect(session.data.account.display_name).toBe("Admin Fixture")
	})

	test("forgetting an account signs it out on this device and hides it from the chooser", async () => {
		const browser = new TestBrowser(t)
		await browser.signIn("admin@test.gezcez.com")
		await browser.signIn("analyst@test.gezcez.com")
		type Accounts = { accounts: { session_id: string; account: { display_name: string } }[] }
		const list = await browser.get<Accounts>("/v1/account/device-accounts")
		const admin = list.data.accounts.find((a) => a.account.display_name === "Admin Fixture")!
		const analyst = list.data.accounts.find(
			(a) => a.account.display_name === "Analyst Fixture",
		)!

		const elsewhere = new TestBrowser(t)
		await elsewhere.csrf()
		const foreign = await elsewhere.request(
			"DELETE",
			`/v1/account/device-accounts/${admin.session_id}`,
		)
		expect(foreign.body.error.code).toBe("NOT_FOUND")

		const forgot = await browser.request<{ forgotten: boolean; signed_out_current: boolean }>(
			"DELETE",
			`/v1/account/device-accounts/${admin.session_id}`,
		)
		expect(forgot.data).toEqual({ forgotten: true, signed_out_current: false })
		const after = await browser.get<Accounts>("/v1/account/device-accounts")
		expect(after.data.accounts.map((a) => a.account.display_name)).toEqual(["Analyst Fixture"])
		const revoked = db()
			.select()
			.from(sessionsTable)
			.where(eq(sessionsTable.id, admin.session_id))
			.get()!
		expect(revoked.revoked_at).not.toBeNull()
		const switchBack = await browser.post("/v1/account/session/switch", {
			session_id: admin.session_id,
		})
		expect(switchBack.body.error.code).toBe("AUTH_SESSION_REQUIRED")

		// Forgetting the active account also clears the session cookie.
		const current = await browser.request<{ signed_out_current: boolean }>(
			"DELETE",
			`/v1/account/device-accounts/${analyst.session_id}`,
		)
		expect(current.data.signed_out_current).toBe(true)
		expect(browser.cookies.has("__Host-gz_session")).toBe(false)
		const empty = await browser.get<Accounts>("/v1/account/device-accounts")
		expect(empty.data.accounts).toEqual([])

		// Signing in again brings the account back.
		await browser.signIn("admin@test.gezcez.com")
		const back = await browser.get<Accounts>("/v1/account/device-accounts")
		expect(back.data.accounts.map((a) => a.account.display_name)).toEqual(["Admin Fixture"])
	})

	test("switching to a session of another device is refused", async () => {
		const mine = new TestBrowser(t)
		await mine.signIn("netadmin@test.gezcez.com")
		const sessionId = (await mine.get<{ session: { id: string } }>("/v1/account/session")).data
			.session.id
		const other = new TestBrowser(t)
		await other.csrf()
		const res = await other.post("/v1/account/session/switch", { session_id: sessionId })
		expect(res.body.error.code).toBe("AUTH_SESSION_REQUIRED")
	})

	test("signing in again on the same device replaces the earlier session", async () => {
		const browser = new TestBrowser(t)
		await browser.signIn("root@test.gezcez.com")
		const first = (await browser.get<{ session: { id: string } }>("/v1/account/session")).data
			.session.id
		await browser.signIn("root@test.gezcez.com")
		const second = (await browser.get<{ session: { id: string } }>("/v1/account/session")).data
			.session.id
		expect(second).not.toBe(first)
		const list = await browser.get<{ accounts: unknown[] }>("/v1/account/device-accounts")
		expect(list.data.accounts).toHaveLength(1)
	})

	test("re-auth by code refreshes auth_time on the current session", async () => {
		const browser = new TestBrowser(t)
		await browser.signIn("rider@test.gezcez.com")
		const before = (
			await browser.get<{ session: { auth_time: string } }>("/v1/account/session")
		).data.session.auth_time
		await Bun.sleep(5)
		const start = await browser.post<{ flow_id: string }>("/v1/account/email/start", {
			intent: "reauth",
		})
		expect(start.status).toBe(202)
		const code = await browser.lastCode("rider@test.gezcez.com")
		const verify = await browser.post<{ status: string; auth_time: string }>(
			"/v1/account/email/verify",
			{
				flow_id: start.data.flow_id,
				code,
			},
		)
		expect(verify.data.status).toBe("signed_in")
		expect(new Date(verify.data.auth_time).getTime()).toBeGreaterThan(
			new Date(before).getTime(),
		)
	})

	test("re-auth needs a session", async () => {
		const browser = new TestBrowser(t)
		await browser.csrf()
		const res = await browser.post("/v1/account/email/start", { intent: "reauth" })
		expect(res.body.error.code).toBe("AUTH_SESSION_REQUIRED")
	})
})

describe("staging test OTP", () => {
	test("test addresses accept the fixed code and receive no mail", async () => {
		const staging = await createTestApp({
			PUBLIC_API_URL: "https://api-staging.gezcez.com",
			STAGING_TEST_OTP: "424242",
		})
		try {
			const browser = new TestBrowser(staging)
			await browser.csrf()
			const start = await browser.post<{ flow_id: string }>("/v1/account/email/start", {
				email: "maestro@test.gezcez.com",
				intent: "signin",
			})
			const verify = await browser.post<{ status: string }>("/v1/account/email/verify", {
				flow_id: start.data.flow_id,
				code: "424242",
			})
			expect(verify.data.status).toBe("needs_profile")
			const mail = await staging.json<{ data: { messages: unknown[] } }>(
				"/v1/__test/mailbox?to=maestro@test.gezcez.com",
			)
			expect(mail.body.data.messages).toEqual([])
		} finally {
			await staging.close()
		}
	})
})
