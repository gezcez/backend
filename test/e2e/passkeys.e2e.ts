import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { eq } from "drizzle-orm"
import { DatabaseService } from "@db"
import { passkeysTable, sessionsTable, usersTable, webauthnChallengesTable } from "@schemas/core"
import { createTestApp, type TestApp } from "../helpers/app"
import { SoftAuthenticator } from "../helpers/authenticator"
import { TestBrowser } from "../helpers/browser"
import { claims, TestOAuthClient } from "../helpers/oauth-client"

let t: TestApp

beforeAll(async () => {
	t = await createTestApp()
})
afterAll(async () => {
	await t.close()
})

const db = () => t.app.get(DatabaseService).core

interface CreationOptions {
	challenge_id: string
	challenge: string
	rp: { id?: string; name: string }
	user: { id: string; name: string; displayName: string }
	excludeCredentials?: { id: string; type: string }[]
	authenticatorSelection?: { residentKey?: string }
	attestation?: string
}
interface RequestOptions {
	challenge_id: string
	challenge: string
	rpId?: string
	allowCredentials?: { id: string }[]
}
interface Passkey {
	id: string
	name: string
	created_at: string
	last_used_at: string | null
	device_hint: string | null
	backed_up: boolean
}

async function signedIn(email: string) {
	const browser = new TestBrowser(t)
	await browser.signIn(email)
	return browser
}

async function makeStale(browser: TestBrowser) {
	const res = await browser.get<{ session: { id: string } }>("/v1/account/session")
	db().update(sessionsTable)
		.set({ auth_time: new Date(Date.now() - 3600_000) })
		.where(eq(sessionsTable.id, res.data.session.id))
		.run()
}

/** Registers one passkey on `browser` with a new software authenticator. */
async function register(browser: TestBrowser, name?: string) {
	const authenticator = new SoftAuthenticator(browser.origin)
	const options = await browser.post<CreationOptions>("/v1/account/passkeys/options")
	expect(options.status).toBe(200)
	const { response, credential } = authenticator.create(options.data)
	const saved = await browser.post<Passkey>("/v1/account/passkeys", {
		challenge_id: options.data.challenge_id,
		credential: response,
		...(name ? { name } : {}),
	})
	expect(saved.status).toBe(201)
	return { authenticator, credential, passkey: saved.data }
}

async function passkeySignIn(
	browser: TestBrowser,
	authenticator: SoftAuthenticator,
	overrides: Parameters<SoftAuthenticator["get"]>[1] = {},
) {
	if (!browser.csrfToken) await browser.csrf()
	const options = await browser.post<RequestOptions>("/v1/account/passkeys/signin/options", {})
	expect(options.status).toBe(200)
	return browser.post<{ status: string; account: { display_name: string }; auth_time: string }>(
		"/v1/account/passkeys/signin/verify",
		{ challenge_id: options.data.challenge_id, credential: authenticator.get(options.data, overrides) },
	)
}

describe("passkey registration", () => {
	test("options follow the plan: RP gezcez.com, discoverable, no attestation, step-up", async () => {
		const browser = await signedIn("pk-options@example.com")
		const options = await browser.post<CreationOptions>("/v1/account/passkeys/options")
		expect(options.status).toBe(200)
		expect(options.data.challenge_id).toMatch(/^wc_[0-9A-Z]{26}$/)
		expect(options.data.rp).toEqual({ id: "gezcez.com", name: "gezcez" })
		expect(options.data.user.name).toBe("pk-options@example.com")
		expect(options.data.authenticatorSelection?.residentKey).toBe("required")
		expect(options.data.attestation).toBe("none")
		expect(options.data.excludeCredentials).toEqual([])

		await makeStale(browser)
		const stale = await browser.post("/v1/account/passkeys/options")
		expect(stale.status).toBe(403)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		expect(stale.body.error.details).toEqual({ max_age: 600 })

		const anonymous = new TestBrowser(t)
		await anonymous.csrf()
		expect((await anonymous.post("/v1/account/passkeys/options")).body.error.code).toBe(
			"AUTH_SESSION_REQUIRED",
		)
	})

	test("register, then list, profile and security show it", async () => {
		const browser = await signedIn("pk-register@example.com")
		const { passkey, credential } = await register(browser, "My phone")
		expect(passkey).toMatchObject({
			id: expect.stringMatching(/^pk_[0-9A-Z]{26}$/),
			name: "My phone",
			last_used_at: null,
			backed_up: false,
		})
		const q = db().select().from(passkeysTable).where(eq(passkeysTable.id, passkey.id))
		console.log("DBG", q.toSQL(), JSON.stringify(passkey))
		const row = q.get()!
		expect(row.credential_id).toBe(credential.id)
		expect(row.transports).toEqual(["internal", "hybrid"])
		expect(row.sign_count).toBe(0)

		const list = await browser.get<{ passkeys: Passkey[] }>("/v1/account/passkeys")
		expect(list.data.passkeys.map((p) => p.id)).toEqual([passkey.id])
		const profile = await browser.get<{ passkey_count: number }>("/v1/account/profile")
		expect(profile.data.passkey_count).toBe(1)
		const security = await browser.get<{
			passkeys: { id: string; name: string }[]
			recent_events: { type: string }[]
		}>("/v1/account/security")
		expect(security.data.passkeys).toEqual([
			expect.objectContaining({ id: passkey.id, name: "My phone" }),
		])
		expect(security.data.recent_events.map((e) => e.type)).toContain("auth.passkey_added")

		// The next options exclude the registered credential.
		const again = await browser.post<CreationOptions>("/v1/account/passkeys/options")
		expect(again.data.excludeCredentials?.map((c) => c.id)).toEqual([credential.id])
	})

	test("the name defaults to the device label", async () => {
		const browser = await signedIn("pk-default-name@example.com")
		const { passkey } = await register(browser)
		expect(passkey.name.length).toBeGreaterThan(0)
		expect(passkey.device_hint).toBe(passkey.name)
	})

	test("challenges are single use, bound to the session, and must match origin and RP", async () => {
		const browser = await signedIn("pk-bad-register@example.com")
		const authenticator = new SoftAuthenticator(browser.origin)

		const attempt = async (
			mutate: (options: CreationOptions) => {
				response: unknown
				challengeId?: string
				via?: TestBrowser
			},
		) => {
			const options = await browser.post<CreationOptions>("/v1/account/passkeys/options")
			const { response, challengeId, via } = mutate(options.data)
			return (via ?? browser).post("/v1/account/passkeys", {
				challenge_id: challengeId ?? options.data.challenge_id,
				credential: response,
			})
		}

		const wrongOrigin = await attempt((o) => ({
			response: authenticator.create(o, { origin: "https://evil.example" }).response,
		}))
		expect(wrongOrigin.status).toBe(400)
		expect(wrongOrigin.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		const wrongRp = await attempt((o) => ({
			response: authenticator.create(o, { rpId: "evil.example" }).response,
		}))
		expect(wrongRp.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		const wrongChallenge = await attempt((o) => ({
			response: authenticator.create({ ...o, challenge: "AAAA" }).response,
		}))
		expect(wrongChallenge.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		const unknown = await attempt((o) => ({
			response: authenticator.create(o).response,
			challengeId: "wc_01JZZZZZZZZZZZZZZZZZZZZZZZ",
		}))
		expect(unknown.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		// Another session of another user cannot spend this session's challenge.
		const other = await signedIn("pk-other-session@example.com")
		const stolen = await attempt((o) => ({
			response: authenticator.create(o).response,
			via: other,
		}))
		expect(stolen.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		// A spent challenge (even by a failed verify) cannot be reused.
		const options = await browser.post<CreationOptions>("/v1/account/passkeys/options")
		const good = authenticator.create(options.data)
		const first = await browser.post("/v1/account/passkeys", {
			challenge_id: options.data.challenge_id,
			credential: good.response,
		})
		expect(first.status).toBe(201)
		const replay = await browser.post("/v1/account/passkeys", {
			challenge_id: options.data.challenge_id,
			credential: good.response,
		})
		expect(replay.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		// Expired challenges are refused.
		const late = await browser.post<CreationOptions>("/v1/account/passkeys/options")
		db().update(webauthnChallengesTable)
			.set({ expires_at: new Date(Date.now() - 1000) })
			.where(eq(webauthnChallengesTable.id, late.data.challenge_id))
			.run()
		const expired = await browser.post("/v1/account/passkeys", {
			challenge_id: late.data.challenge_id,
			credential: new SoftAuthenticator(browser.origin).create(late.data).response,
		})
		expect(expired.body.error.code).toBe("AUTH_PASSKEY_INVALID")
	})

	test("one credential cannot be registered twice", async () => {
		const browser = await signedIn("pk-duplicate@example.com")
		const { authenticator } = await register(browser)
		const options = await browser.post<CreationOptions>("/v1/account/passkeys/options")
		// A misbehaving client that ignores excludeCredentials and attests the same credential.
		const first = authenticator.credentials[0]!
		const { response } = authenticator.create(options.data, { reuse: first })
		const res = await browser.post("/v1/account/passkeys", {
			challenge_id: options.data.challenge_id,
			credential: response,
		})
		expect(res.status).toBe(409)
		expect(res.body.error.code).toBe("CONFLICT")
		expect(
			db().select().from(passkeysTable).where(eq(passkeysTable.credential_id, first.id)).all(),
		).toHaveLength(1)
	})

	test("malformed credentials are validation errors", async () => {
		const browser = await signedIn("pk-malformed@example.com")
		const options = await browser.post<CreationOptions>("/v1/account/passkeys/options")
		const res = await browser.post("/v1/account/passkeys", {
			challenge_id: options.data.challenge_id,
			credential: { id: "not base64url!", type: "public-key" },
		})
		expect(res.status).toBe(400)
		expect(res.body.error.code).toBe("VALIDATION_FAILED")
	})
})

describe("passkey management", () => {
	test("rename and delete behind step-up; other users' passkeys are not found", async () => {
		const browser = await signedIn("pk-manage@example.com")
		const { passkey } = await register(browser, "Laptop")
		const renamed = await browser.request<Passkey>("PATCH", `/v1/account/passkeys/${passkey.id}`, {
			name: "  Work laptop  ",
		})
		expect(renamed.status).toBe(200)
		expect(renamed.data.name).toBe("Work laptop")

		const blank = await browser.request("PATCH", `/v1/account/passkeys/${passkey.id}`, {
			name: "   ",
		})
		expect(blank.body.error.code).toBe("VALIDATION_FAILED")

		const intruder = await signedIn("pk-intruder@example.com")
		const foreign = await intruder.request("DELETE", `/v1/account/passkeys/${passkey.id}`)
		expect(foreign.status).toBe(404)
		expect(
			(await intruder.request("PATCH", `/v1/account/passkeys/${passkey.id}`, { name: "x" }))
				.status,
		).toBe(404)

		await makeStale(browser)
		const stale = await browser.request("DELETE", `/v1/account/passkeys/${passkey.id}`)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		const staleRename = await browser.request("PATCH", `/v1/account/passkeys/${passkey.id}`, {
			name: "x",
		})
		expect(staleRename.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		// Listing needs no step-up.
		expect((await browser.get("/v1/account/passkeys")).status).toBe(200)

		const fresh = await signedIn("pk-manage@example.com")
		const removed = await fresh.request("DELETE", `/v1/account/passkeys/${passkey.id}`)
		expect(removed.status).toBe(200)
		const list = await fresh.get<{ passkeys: Passkey[] }>("/v1/account/passkeys")
		expect(list.data.passkeys).toEqual([])
		const security = await fresh.get<{ recent_events: { type: string }[] }>(
			"/v1/account/security",
		)
		expect(security.data.recent_events.map((e) => e.type)).toContain("auth.passkey_removed")
	})
})

describe("passkey sign-in", () => {
	test("a discoverable passkey signs in on a new browser with amr webauthn", async () => {
		const owner = await signedIn("pk-signin@example.com")
		const { authenticator, passkey } = await register(owner)

		const browser = new TestBrowser(t)
		await browser.csrf()
		const options = await browser.post<RequestOptions & { userVerification?: string }>(
			"/v1/account/passkeys/signin/options",
			{},
		)
		expect(options.status).toBe(200)
		expect(options.data.rpId).toBe("gezcez.com")
		expect(options.data.allowCredentials ?? []).toEqual([])
		const verify = await browser.post<{ status: string; account: { email: string } }>(
			"/v1/account/passkeys/signin/verify",
			{ challenge_id: options.data.challenge_id, credential: authenticator.get(options.data) },
		)
		expect(verify.status).toBe(200)
		expect(verify.data).toMatchObject({
			status: "signed_in",
			account: { email: "pk-signin@example.com" },
		})
		expect(browser.cookies.has("__Host-gz_session")).toBe(true)
		const session = await browser.get<{ session: { amr: string[] } }>("/v1/account/session")
		expect(session.data.session.amr).toEqual(["webauthn"])

		const row = db().select().from(passkeysTable).where(eq(passkeysTable.id, passkey.id)).get()!
		expect(row.sign_count).toBe(1)
		expect(row.last_used_at).not.toBeNull()

		// The access token minted from this session says so too.
		const client = new TestOAuthClient(t, "dashboard-dev", "http://localhost:5173/auth/callback")
		const { code } = await client.signInAndAuthorize(browser, { scope: "openid profile" })
		const token = await client.exchange(code!)
		expect(token.status).toBe(200)
		expect(claims(token.body.access_token).amr).toEqual(["webauthn"])
	})

	test("counter regression, wrong key, wrong origin and unknown credentials are refused", async () => {
		const owner = await signedIn("pk-attacks@example.com")
		const { authenticator, credential } = await register(owner)
		const browser = new TestBrowser(t)

		expect((await passkeySignIn(browser, authenticator)).status).toBe(200)
		expect((await passkeySignIn(browser, authenticator)).status).toBe(200)

		const cloned = await passkeySignIn(browser, authenticator, { counter: 1 })
		expect(cloned.status).toBe(400)
		expect(cloned.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
		const forged = await passkeySignIn(browser, authenticator, { signWith: privateKey })
		expect(forged.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		const phished = await passkeySignIn(browser, authenticator, {
			origin: "https://gezcez.com.evil.example",
		})
		expect(phished.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		const otherRp = await passkeySignIn(browser, authenticator, {
			credential,
			rpId: "evil.example",
		})
		expect(otherRp.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		const wrongHandle = await passkeySignIn(browser, authenticator, {
			userHandle: Buffer.from("01JNOTTHEOWNER0000000000000").toString("base64url"),
		})
		expect(wrongHandle.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		const stranger = new SoftAuthenticator(browser.origin)
		stranger.create({
			challenge: "AAAA",
			rp: { id: "gezcez.com", name: "gezcez" },
			user: { id: "dXNlcg", name: "x", displayName: "x" },
		})
		const unknown = await passkeySignIn(browser, stranger)
		expect(unknown.body.error.code).toBe("AUTH_PASSKEY_INVALID")

		// No user handle is fine (non-discoverable flows), the credential id names the owner.
		const noHandle = await passkeySignIn(browser, authenticator, {
			credential,
			userHandle: null,
		})
		expect(noHandle.status).toBe(200)
	})

	test("a sign-in challenge works once and only on the browser that asked", async () => {
		const owner = await signedIn("pk-challenge@example.com")
		const { authenticator } = await register(owner)
		const browser = new TestBrowser(t)
		await browser.csrf()
		const options = await browser.post<RequestOptions>("/v1/account/passkeys/signin/options", {})

		const elsewhere = new TestBrowser(t)
		await elsewhere.csrf()
		const moved = await elsewhere.post("/v1/account/passkeys/signin/verify", {
			challenge_id: options.data.challenge_id,
			credential: authenticator.get(options.data),
		})
		expect(moved.body.error.code).toBe("AUTH_PASSKEY_INVALID")
		// The failed attempt spent it.
		const after = await browser.post("/v1/account/passkeys/signin/verify", {
			challenge_id: options.data.challenge_id,
			credential: authenticator.get(options.data),
		})
		expect(after.body.error.code).toBe("AUTH_PASSKEY_INVALID")
	})

	test("banned accounts get USER_BANNED and deleted passkeys stop working", async () => {
		const owner = await signedIn("pk-banned@example.com")
		const { authenticator, passkey } = await register(owner)
		db().update(usersTable)
			.set({ status: "banned" })
			.where(eq(usersTable.email, "pk-banned@example.com"))
			.run()
		const banned = await passkeySignIn(new TestBrowser(t), authenticator)
		expect(banned.status).toBe(403)
		expect(banned.body.error.code).toBe("USER_BANNED")
		db().update(usersTable)
			.set({ status: "active" })
			.where(eq(usersTable.email, "pk-banned@example.com"))
			.run()

		const fresh = await signedIn("pk-banned@example.com")
		await fresh.request("DELETE", `/v1/account/passkeys/${passkey.id}`)
		const gone = await passkeySignIn(new TestBrowser(t), authenticator)
		expect(gone.body.error.code).toBe("AUTH_PASSKEY_INVALID")
	})

	test("sign-in endpoints need the CSRF token and an allowed origin", async () => {
		const browser = new TestBrowser(t)
		await browser.csrf()
		const noCsrf = await browser.post("/v1/account/passkeys/signin/options", {}, {
			"x-csrf-token": "",
		})
		expect(noCsrf.body.error.code).toBe("CSRF_INVALID")
		const evil = new TestBrowser(t, { origin: "https://evil.example" })
		await evil.csrf()
		const res = await evil.post("/v1/account/passkeys/signin/options", {})
		expect(res.status).toBe(403)
	})
})

describe("passkey re-auth", () => {
	test("refreshes auth_time and adds webauthn to amr on the same session", async () => {
		const browser = await signedIn("pk-reauth@example.com")
		const { authenticator } = await register(browser)
		const before = await browser.get<{ session: { id: string } }>("/v1/account/session")
		await makeStale(browser)
		expect((await browser.post("/v1/account/sessions/revoke-others")).body.error.code).toBe(
			"AUTH_STEP_UP_REQUIRED",
		)

		const options = await browser.post<RequestOptions>("/v1/account/passkeys/reauth/options")
		expect(options.status).toBe(200)
		expect(options.data.allowCredentials?.map((c) => c.id)).toEqual([
			authenticator.credentials[0]!.id,
		])
		const verify = await browser.post<{ auth_time: string }>(
			"/v1/account/passkeys/reauth/verify",
			{ challenge_id: options.data.challenge_id, credential: authenticator.get(options.data) },
		)
		expect(verify.status).toBe(200)
		expect(Date.now() - new Date(verify.data.auth_time).getTime()).toBeLessThan(10_000)
		const after = await browser.get<{ session: { id: string; amr: string[] } }>(
			"/v1/account/session",
		)
		expect(after.data.session.id).toBe(before.data.session.id)
		expect(after.data.session.amr).toEqual(["webauthn", "otp"])
		expect((await browser.post("/v1/account/sessions/revoke-others")).status).toBe(200)
	})

	test("another account's passkey cannot re-authenticate this session", async () => {
		const victim = await signedIn("pk-reauth-victim@example.com")
		await register(victim)
		const attacker = await signedIn("pk-reauth-attacker@example.com")
		const { authenticator: attackerKey } = await register(attacker)

		const options = await victim.post<RequestOptions>("/v1/account/passkeys/reauth/options")
		const res = await victim.post("/v1/account/passkeys/reauth/verify", {
			challenge_id: options.data.challenge_id,
			credential: attackerKey.get({ ...options.data, allowCredentials: [] }),
		})
		expect(res.body.error.code).toBe("AUTH_PASSKEY_INVALID")
		// A sign-in challenge is not a re-auth challenge.
		const signin = await victim.post<RequestOptions>("/v1/account/passkeys/signin/options", {})
		const wrongKind = await victim.post("/v1/account/passkeys/reauth/verify", {
			challenge_id: signin.data.challenge_id,
			credential: attackerKey.get(signin.data),
		})
		expect(wrongKind.body.error.code).toBe("AUTH_PASSKEY_INVALID")
	})

	test("accounts without passkeys get NOT_FOUND for re-auth options", async () => {
		const browser = await signedIn("pk-reauth-none@example.com")
		const res = await browser.post("/v1/account/passkeys/reauth/options")
		expect(res.status).toBe(404)
	})
})

describe("openapi", () => {
	test("the passkey endpoints are published", async () => {
		const spec = await t.json<{ paths: Record<string, Record<string, unknown>> }>(
			"/openapi.json",
		)
		const paths = spec.body.paths
		expect(Object.keys(paths["/v1/account/passkeys"] ?? {}).sort()).toEqual(["get", "post"])
		expect(paths["/v1/account/passkeys/options"]?.post).toBeDefined()
		expect(paths["/v1/account/passkeys/signin/options"]?.post).toBeDefined()
		expect(paths["/v1/account/passkeys/signin/verify"]?.post).toBeDefined()
		expect(paths["/v1/account/passkeys/reauth/options"]?.post).toBeDefined()
		expect(paths["/v1/account/passkeys/reauth/verify"]?.post).toBeDefined()
		expect(Object.keys(paths["/v1/account/passkeys/{passkeyId}"] ?? {}).sort()).toEqual([
			"delete",
			"patch",
		])
	})
})
