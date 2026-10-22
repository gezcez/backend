import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { DatabaseService } from "@db"
import { sessionsTable, usersTable } from "@schemas/core"
import { BreachedPasswordService } from "@services/account/breached-password.service"
import { TurnstileService } from "@services/account/turnstile.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { TestBrowser } from "../helpers/browser"

const PASSWORD = "correct horse battery"

let t: TestApp

beforeAll(async () => {
	t = await createTestApp()
})
afterAll(async () => {
	await t.close()
})

const db = () => t.app.get(DatabaseService).core

function user(email: string) {
	return db().select().from(usersTable).where(eq(usersTable.email, email)).get()!
}

async function passwordLogin(browser: TestBrowser, email: string, password: string) {
	if (!browser.csrfToken) await browser.csrf()
	return browser.post<{ status: string; account: { display_name: string } }>(
		"/v1/account/password/login",
		{ email, password },
	)
}

async function withPassword(email: string, password = PASSWORD) {
	const browser = new TestBrowser(t)
	await browser.signIn(email)
	const res = await browser.request("PUT", "/v1/account/password", { new_password: password })
	if (res.status !== 200) throw new Error(`set password failed: ${JSON.stringify(res.body)}`)
	return browser
}

describe("password login", () => {
	test("unknown email, no password set and wrong password are the same error", async () => {
		const browser = new TestBrowser(t)
		for (const [email, password] of [
			["nobody@example.com", PASSWORD],
			["rider@test.gezcez.com", PASSWORD],
		]) {
			const res = await passwordLogin(browser, email!, password!)
			expect(res.status).toBe(401)
			expect(res.body.error.code).toBe("AUTH_PASSWORD_INVALID")
		}
	})

	test("set a password, then sign in with it on another browser", async () => {
		const owner = await withPassword("moderator@test.gezcez.com")
		const notice = await t.json<{ data: { messages: { template: string }[] } }>(
			"/v1/__test/mailbox?to=moderator@test.gezcez.com",
		)
		expect(notice.body.data.messages.at(-1)?.template).toBe("password_changed")
		expect(user("moderator@test.gezcez.com").password_algo).toBe("argon2id")

		const browser = new TestBrowser(t)
		const wrong = await passwordLogin(browser, "moderator@test.gezcez.com", "wrong password!!")
		expect(wrong.body.error.code).toBe("AUTH_PASSWORD_INVALID")
		const ok = await passwordLogin(browser, "Moderator@Test.Gezcez.com", PASSWORD)
		expect(ok.status).toBe(200)
		expect(ok.data).toMatchObject({
			status: "signed_in",
			account: { display_name: "Moderator Fixture" },
		})
		const session = await browser.get<{ session: { amr: string[] } }>("/v1/account/session")
		expect(session.data.session.amr).toEqual(["pwd"])
		// Setting a password does not sign the other browser out.
		expect((await owner.get("/v1/account/session")).status).toBe(200)
	})

	test("new passwords: 10 to 128 characters and not breached", async () => {
		const browser = new TestBrowser(t)
		await browser.signIn("analyst@test.gezcez.com")
		const short = await browser.request("PUT", "/v1/account/password", {
			new_password: "short",
		})
		expect(short.body.error).toMatchObject({
			code: "AUTH_PASSWORD_WEAK",
			details: { min_length: 10, max_length: 128 },
		})
		const long = await browser.request("PUT", "/v1/account/password", {
			new_password: "x".repeat(129),
		})
		expect(long.body.error.code).toBe("AUTH_PASSWORD_WEAK")

		const breached = t.app.get(BreachedPasswordService)
		const original = breached.fetchImpl
		const seen: string[] = []
		const sha1 = createHash("sha1").update("password123").digest("hex").toUpperCase()
		breached.fetchImpl = async (url) => {
			seen.push(url)
			return new Response(`${sha1.slice(5)}:12345\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0`)
		}
		try {
			const res = await browser.request("PUT", "/v1/account/password", {
				new_password: "password123",
			})
			expect(res.body.error.code).toBe("AUTH_PASSWORD_BREACHED")
			// Only the 5-character prefix leaves the server.
			expect(seen).toEqual([`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`])
		} finally {
			breached.fetchImpl = original
		}
	})

	test("legacy bcrypt hashes work and are rehashed to argon2id", async () => {
		const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 })
		db()
			.insert(usersTable)
			.values({
				public_id: "01JLEGACYBCRYPT0000000000",
				email: "legacy@example.com",
				display_name: "Legacy",
				password_hash: hash,
				password_algo: "bcrypt",
			})
			.run()
		const res = await passwordLogin(new TestBrowser(t), "legacy@example.com", PASSWORD)
		expect(res.status).toBe(200)
		const row = user("legacy@example.com")
		expect(row.password_algo).toBe("argon2id")
		expect(row.password_hash).toStartWith("$argon2id$")
		expect(
			(await passwordLogin(new TestBrowser(t), "legacy@example.com", PASSWORD)).status,
		).toBe(200)
	})

	test("removing the password goes back to codes only", async () => {
		const browser = await withPassword("netadmin@test.gezcez.com")
		const removed = await browser.request("DELETE", "/v1/account/password")
		expect(removed.status).toBe(200)
		const res = await passwordLogin(new TestBrowser(t), "netadmin@test.gezcez.com", PASSWORD)
		expect(res.body.error.code).toBe("AUTH_PASSWORD_INVALID")
	})
})

describe("step-up and re-auth", () => {
	test("password changes need a recent authentication; password re-auth provides it", async () => {
		const browser = await withPassword("admin@test.gezcez.com")
		const sessionId = (await browser.get<{ session: { id: string } }>("/v1/account/session"))
			.data.session.id
		db()
			.update(sessionsTable)
			.set({ auth_time: new Date(Date.now() - 3600_000) })
			.where(eq(sessionsTable.id, sessionId))
			.run()

		const stale = await browser.request("PUT", "/v1/account/password", {
			new_password: "another long password",
		})
		expect(stale.status).toBe(403)
		expect(stale.body.error).toMatchObject({
			code: "AUTH_STEP_UP_REQUIRED",
			details: { max_age: 600 },
		})

		const wrong = await browser.post("/v1/account/reauth", { password: "not the password" })
		expect(wrong.body.error.code).toBe("AUTH_PASSWORD_INVALID")
		const reauth = await browser.post<{ auth_time: string }>("/v1/account/reauth", {
			password: PASSWORD,
		})
		expect(reauth.status).toBe(200)
		expect(Date.now() - new Date(reauth.data.auth_time).getTime()).toBeLessThan(5000)
		const session = await browser.get<{ session: { amr: string[] } }>("/v1/account/session")
		expect(session.data.session.amr).toEqual(["pwd", "otp"])

		const fresh = await browser.request("PUT", "/v1/account/password", {
			new_password: "another long password",
		})
		expect(fresh.status).toBe(200)
	})
})

describe("password reset", () => {
	test("code, reset token, new password: every other session ends, the token works once", async () => {
		const other = await withPassword("root@test.gezcez.com")
		const browser = new TestBrowser(t)
		await browser.csrf()
		const start = await browser.post<{ flow_id: string }>("/v1/account/email/start", {
			email: "root@test.gezcez.com",
			intent: "reset",
		})
		const mail = await t.json<{ data: { messages: { template: string }[] } }>(
			"/v1/__test/mailbox?to=root@test.gezcez.com",
		)
		expect(mail.body.data.messages.at(-1)?.template).toBe("reset_code")
		const code = await browser.lastCode("root@test.gezcez.com")
		const verify = await browser.post<{ status: string; reset_token: string }>(
			"/v1/account/email/verify",
			{ flow_id: start.data.flow_id, code },
		)
		expect(verify.data.status).toBe("reset_ready")

		const weak = await browser.post("/v1/account/password/reset", {
			reset_token: verify.data.reset_token,
			new_password: "short",
		})
		expect(weak.body.error.code).toBe("AUTH_PASSWORD_WEAK")

		const reset = await browser.post<{ status: string }>("/v1/account/password/reset", {
			reset_token: verify.data.reset_token,
			new_password: "a brand new passphrase",
		})
		expect(reset.status).toBe(200)
		expect(reset.data.status).toBe("signed_in")
		expect((await browser.get("/v1/account/session")).status).toBe(200)
		expect((await other.get("/v1/account/session")).body.error.code).toBe(
			"AUTH_SESSION_REQUIRED",
		)

		const again = await browser.post("/v1/account/password/reset", {
			reset_token: verify.data.reset_token,
			new_password: "yet another passphrase",
		})
		expect(again.body.error.code).toBe("AUTH_CODE_EXPIRED")
		const login = await passwordLogin(
			new TestBrowser(t),
			"root@test.gezcez.com",
			"a brand new passphrase",
		)
		expect(login.status).toBe(200)
	})

	test("forged reset tokens are refused", async () => {
		const browser = new TestBrowser(t)
		await browser.csrf()
		const res = await browser.post("/v1/account/password/reset", {
			reset_token: "eyJ1aWQiOjF9.forged",
			new_password: "a brand new passphrase",
		})
		expect(res.body.error.code).toBe("AUTH_CODE_EXPIRED")
	})
})

describe("Turnstile", () => {
	test("email codes reject a failed check and continue (rate limited) when Cloudflare is down", async () => {
		const app = await createTestApp({ TURNSTILE_SECRET: "test-secret" })
		try {
			const turnstile = app.app.get(TurnstileService)
			const calls: string[] = []
			turnstile.fetchImpl = async (_url, init) => {
				calls.push(String(init.body))
				return Response.json({ success: false })
			}
			const browser = new TestBrowser(app)
			await browser.csrf()
			const missing = await browser.post("/v1/account/email/start", {
				email: "someone@example.com",
				intent: "signin",
			})
			expect(missing.body.error.code).toBe("AUTH_TURNSTILE_FAILED")
			expect(calls).toHaveLength(0)

			const failed = await browser.post("/v1/account/email/start", {
				email: "someone@example.com",
				intent: "signin",
				turnstile_token: "bad",
			})
			expect(failed.body.error.code).toBe("AUTH_TURNSTILE_FAILED")
			expect(calls[0]).toContain("response=bad")

			turnstile.fetchImpl = async () => Response.json({ success: true, action: "signup" })
			const wrongAction = await browser.post("/v1/account/email/start", {
				email: "someone@example.com",
				intent: "signin",
				turnstile_token: "good",
			})
			expect(wrongAction.body.error.code).toBe("AUTH_TURNSTILE_FAILED")

			turnstile.fetchImpl = async () => {
				throw new Error("network down")
			}
			const degraded = await browser.post("/v1/account/email/start", {
				email: "someone@example.com",
				intent: "signin",
				turnstile_token: "any",
			})
			expect(degraded.status).toBe(202)

			// Password login fails closed.
			const password = await browser.post("/v1/account/password/login", {
				email: "someone@example.com",
				password: PASSWORD,
				turnstile_token: "any",
			})
			expect(password.body.error.code).toBe("AUTH_TURNSTILE_FAILED")
		} finally {
			await app.close()
		}
	})
})
