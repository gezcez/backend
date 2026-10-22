import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { DatabaseService } from "@db"
import { emailCodesTable, sessionsTable } from "@schemas/core"
import { createTestApp, type TestApp } from "../helpers/app"
import { TestBrowser } from "../helpers/browser"
import { TestOAuthClient } from "../helpers/oauth-client"

let t: TestApp
let counter = 0

beforeAll(async () => {
	t = await createTestApp()
})
afterAll(async () => {
	await t.close()
})

/** A fresh account per test, so tests do not see each other's sessions. */
async function newUser(name = "Self Service") {
	const email = `self-${++counter}@example.com`
	const browser = new TestBrowser(t, {})
	await browser.signIn(email, { displayName: name })
	return { email, browser }
}

async function secondBrowser(email: string) {
	const browser = new TestBrowser(t)
	await browser.signIn(email)
	return browser
}

function makeStale(browser: TestBrowser) {
	return browser.get<{ session: { id: string } }>("/v1/account/session").then((res) =>
		t.app
			.get(DatabaseService)
			.core.update(sessionsTable)
			.set({ auth_time: new Date(Date.now() - 3600_000) })
			.where(eq(sessionsTable.id, res.data.session.id))
			.run(),
	)
}

describe("profile and privacy", () => {
	test("read and update the profile", async () => {
		const { email, browser } = await newUser("Ayşe Yılmaz")
		const profile = await browser.get<Record<string, unknown>>("/v1/account/profile")
		expect(profile.data).toMatchObject({
			display_name: "Ayşe Yılmaz",
			email,
			locale: "en",
			has_password: false,
			passkey_count: 0,
		})
		expect(profile.data.email_verified_at).toBeString()
		const patched = await browser.request<{ display_name: string; locale: string }>(
			"PATCH",
			"/v1/account/profile",
			{ display_name: "Ayşe Y.", locale: "tr" },
		)
		expect(patched.data).toMatchObject({ display_name: "Ayşe Y.", locale: "tr" })
		const empty = await browser.request("PATCH", "/v1/account/profile", {})
		expect(empty.body.error.code).toBe("VALIDATION_FAILED")
	})

	test("privacy toggles default to off", async () => {
		const { browser } = await newUser()
		const privacy = await browser.get("/v1/account/privacy")
		expect(privacy.data).toEqual({ location_history_opt_in: false, product_emails: false })
		const patched = await browser.request("PATCH", "/v1/account/privacy", {
			product_emails: true,
		})
		expect(patched.data).toEqual({ location_history_opt_in: false, product_emails: true })
	})

	test("account pages need the session and the CSRF token on writes", async () => {
		const anonymous = new TestBrowser(t)
		expect((await anonymous.get("/v1/account/profile")).body.error.code).toBe(
			"AUTH_SESSION_REQUIRED",
		)
		const { browser } = await newUser()
		browser.csrfToken = "forged"
		const res = await browser.request("PATCH", "/v1/account/profile", { locale: "tr" })
		expect(res.body.error.code).toBe("CSRF_INVALID")
	})
})

describe("sessions", () => {
	test("list shows every live session with the apps using it", async () => {
		const { email, browser } = await newUser()
		const phone = await secondBrowser(email)
		const client = new TestOAuthClient(t)
		const { code } = await client.signInAndAuthorize(phone)
		await client.exchange(code!)

		const list = await browser.get<{
			sessions: {
				id: string
				current: boolean
				device: { label: string; kind: string }
				amr: string[]
				apps: { client_id: string; name: string }[]
			}[]
		}>("/v1/account/sessions")
		expect(list.data.sessions).toHaveLength(2)
		expect(list.data.sessions.filter((s) => s.current)).toHaveLength(1)
		const other = list.data.sessions.find((s) => !s.current)!
		expect(other.apps).toEqual([{ client_id: "e2e_client", name: "E2E client" }])
		expect(other.amr).toEqual(["otp"])
		expect(other.device.kind).toBe("desktop")
	})

	test("revoking one session ends it and its refresh families", async () => {
		const { email, browser } = await newUser()
		const phone = await secondBrowser(email)
		const client = new TestOAuthClient(t)
		const token = await client.exchange((await client.signInAndAuthorize(phone)).code!)
		const phoneSession = (await phone.get<{ session: { id: string } }>("/v1/account/session"))
			.data.session.id

		const res = await browser.request("DELETE", `/v1/account/sessions/${phoneSession}`)
		expect(res.status).toBe(200)
		expect((await phone.get("/v1/account/session")).status).toBe(401)
		expect((await client.refresh(token.body.refresh_token!)).body.error).toBe("invalid_grant")

		const stranger = await newUser()
		const mine = (await browser.get<{ session: { id: string } }>("/v1/account/session")).data
			.session.id
		const foreign = await stranger.browser.request("DELETE", `/v1/account/sessions/${mine}`)
		expect(foreign.body.error.code).toBe("NOT_FOUND")
	})

	test("revoke-others keeps only this session and needs step-up", async () => {
		const { email, browser } = await newUser()
		const a = await secondBrowser(email)
		const b = await secondBrowser(email)
		const res = await browser.post<{ revoked: number }>("/v1/account/sessions/revoke-others")
		expect(res.data.revoked).toBe(2)
		expect((await a.get("/v1/account/session")).status).toBe(401)
		expect((await b.get("/v1/account/session")).status).toBe(401)
		expect((await browser.get("/v1/account/session")).status).toBe(200)

		await makeStale(browser)
		const stale = await browser.post("/v1/account/sessions/revoke-others")
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
	})

	test("changing the password signs other sessions out unless asked not to", async () => {
		const { email, browser } = await newUser()
		const other = await secondBrowser(email)
		await browser.request("PUT", "/v1/account/password", {
			new_password: "first long password",
			keep_sessions: true,
		})
		expect((await other.get("/v1/account/session")).status).toBe(200)
		await browser.request("PUT", "/v1/account/password", {
			new_password: "second long password",
		})
		expect((await other.get("/v1/account/session")).status).toBe(401)
		expect((await browser.get("/v1/account/session")).status).toBe(200)
	})
})

describe("authorized apps", () => {
	test("list grants and token clients; revoking ends tokens and the grant", async () => {
		const { browser } = await newUser()
		const thirdParty = new TestOAuthClient(t, "e2e_third_party")
		const start = await thirdParty.authorize(browser)
		const approved = await browser.post<{ redirect_to: string }>(
			`/v1/oauth/authorize/${start.data.request_id}/decision`,
			{ decision: "approve" },
		)
		const token = await thirdParty.exchange(
			thirdParty.callback(approved.data.redirect_to).code!,
		)
		const firstParty = new TestOAuthClient(t)
		await firstParty.exchange((await firstParty.signInAndAuthorize(browser)).code!)

		const apps = await browser.get<{
			apps: {
				client_id: string
				first_party: boolean
				scopes: { key: string }[]
				granted_at: string | null
				active_sessions: number
			}[]
		}>("/v1/account/apps")
		expect(apps.data.apps.map((app) => app.client_id).sort()).toEqual([
			"e2e_client",
			"e2e_third_party",
		])
		const third = apps.data.apps.find((app) => app.client_id === "e2e_third_party")!
		expect(third).toMatchObject({ first_party: false, active_sessions: 1 })
		expect(third.granted_at).toBeString()
		expect(third.scopes.map((scope) => scope.key)).toContain("offline_access")

		const revoked = await browser.request("DELETE", "/v1/account/apps/e2e_third_party")
		expect(revoked.status).toBe(200)
		expect((await thirdParty.refresh(token.body.refresh_token!)).body.error).toBe(
			"invalid_grant",
		)
		const again = await thirdParty.authorize(browser)
		expect(again.data.next).toBe("consent")
		const missing = await browser.request("DELETE", "/v1/account/apps/e2e_third_party")
		expect(missing.body.error.code).toBe("NOT_FOUND")
	})
})

describe("security overview", () => {
	test("lists sign-ins and changes with the device", async () => {
		const { browser } = await newUser()
		await browser.request("PUT", "/v1/account/password", { new_password: "a long password!" })
		const security = await browser.get<{
			has_password: boolean
			password_updated_at?: string
			recent_events: { type: string; device_label?: string }[]
		}>("/v1/account/security")
		expect(security.data.has_password).toBe(true)
		expect(security.data.password_updated_at).toBeString()
		const types = security.data.recent_events.map((event) => event.type)
		expect(types[0]).toBe("auth.password_changed")
		expect(types).toContain("auth.signup")
		expect(types).not.toContain("auth.code_sent")
	})
})

describe("email change", () => {
	test("code to the new address, notice to the old one", async () => {
		const { email, browser } = await newUser()
		const start = await browser.post<{ flow_id: string }>("/v1/account/email/change", {
			new_email: "New.Address@Example.com",
		})
		expect(start.status).toBe(202)
		const code = await browser.lastCode("new.address@example.com")

		// The general verify endpoint never confirms an email change.
		const misuse = await browser.post("/v1/account/email/verify", {
			flow_id: start.data.flow_id,
			code,
		})
		expect(misuse.body.error.code).toBe("AUTH_CODE_EXPIRED")

		const verify = await browser.post<{ email: string }>("/v1/account/email/change/verify", {
			flow_id: start.data.flow_id,
			code,
		})
		expect(verify.status).toBe(200)
		expect(verify.data.email).toBe("new.address@example.com")
		const profile = await browser.get<{ email: string }>("/v1/account/profile")
		expect(profile.data.email).toBe("new.address@example.com")
		const notice = await t.json<{ data: { messages: { template: string }[] } }>(
			`/v1/__test/mailbox?to=${email}`,
		)
		expect(notice.body.data.messages.at(-1)?.template).toBe("email_changed")
	})

	test("a change code can be resent, only by the session that started it", async () => {
		const { browser } = await newUser()
		const address = `resent-${counter}@example.com`
		const start = await browser.post<{ flow_id: string }>("/v1/account/email/change", {
			new_email: address,
		})
		const first = await browser.lastCode(address)
		const early = await browser.post("/v1/account/email/resend", {
			flow_id: start.data.flow_id,
		})
		expect(early.body.error.code).toBe("RATE_LIMITED")
		t.app
			.get(DatabaseService)
			.core.update(emailCodesTable)
			.set({ resend_available_at: new Date(0) })
			.where(eq(emailCodesTable.flow_id, start.data.flow_id))
			.run()

		const other = await newUser()
		const foreign = await other.browser.post("/v1/account/email/resend", {
			flow_id: start.data.flow_id,
		})
		expect(foreign.body.error.code).toBe("AUTH_CODE_EXPIRED")

		const resent = await browser.post<{ resend_available_at: string }>(
			"/v1/account/email/resend",
			{ flow_id: start.data.flow_id },
		)
		expect(resent.status).toBe(200)
		const second = await browser.lastCode(address)
		const mailbox = await t.json<{ data: { messages: { template: string }[] } }>(
			`/v1/__test/mailbox?to=${address}`,
		)
		expect(mailbox.body.data.messages.map((m) => m.template)).toEqual([
			"change_email_code",
			"change_email_code",
		])
		if (second !== first) {
			const stale = await browser.post("/v1/account/email/change/verify", {
				flow_id: start.data.flow_id,
				code: first,
			})
			expect(stale.body.error.code).toBe("AUTH_CODE_INVALID")
		}
		const verify = await browser.post<{ email: string }>("/v1/account/email/change/verify", {
			flow_id: start.data.flow_id,
			code: second,
		})
		expect(verify.data.email).toBe(address)
	})

	test("taken addresses, other users' flows and stale sessions are refused", async () => {
		const { browser } = await newUser()
		const taken = await browser.post("/v1/account/email/change", {
			new_email: "rider@test.gezcez.com",
		})
		expect(taken.body.error.code).toBe("EMAIL_TAKEN")

		const start = await browser.post<{ flow_id: string }>("/v1/account/email/change", {
			new_email: `changed-${counter}@example.com`,
		})
		const code = await browser.lastCode(`changed-${counter}@example.com`)
		const other = await newUser()
		const hijack = await other.browser.post("/v1/account/email/change/verify", {
			flow_id: start.data.flow_id,
			code,
		})
		expect(hijack.body.error.code).toBe("AUTH_CODE_EXPIRED")

		await makeStale(browser)
		const stale = await browser.post("/v1/account/email/change/verify", {
			flow_id: start.data.flow_id,
			code,
		})
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
	})
})
