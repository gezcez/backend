import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { decodeProtectedHeader, SignJWT, generateKeyPair } from "jose"
import { createTestApp, type TestApp } from "@test/helpers/app"
import { GezcezError } from "@common/errors"
import { KeysService } from "./keys.service"

let t: TestApp
let keys: KeysService

beforeAll(async () => {
	t = await createTestApp()
	keys = t.app.get(KeysService)
})
afterAll(async () => {
	await t.close()
})

const input = {
	sub: "01JTESTUSER",
	aud: "e2e_client",
	scope: "openid",
	sid: "01JTESTSESSION",
	auth_time: 1_700_000_000,
	amr: ["otp" as const],
}

describe("KeysService", () => {
	test("creates one active key on first boot and publishes it", () => {
		const jwks = keys.jwks()
		expect(jwks.keys.length).toBe(1)
		expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" })
		expect(jwks.keys[0]).not.toHaveProperty("d")
	})

	test("signs ES256 tokens with a kid and verifies them", async () => {
		const token = await keys.sign(input, 900)
		expect(decodeProtectedHeader(token)).toMatchObject({
			alg: "ES256",
			kid: keys.jwks().keys[0]!.kid,
		})
		const claims = await keys.verify(token)
		expect(claims).toMatchObject({ ...input, iss: t.config.issuer })
		expect(claims.exp - claims.iat).toBe(900)
	})

	test("expired tokens fail with AUTH_TOKEN_EXPIRED", async () => {
		const past = new Date(Date.now() - 3600_000)
		const token = await keys.sign(input, 60, past)
		await expect(keys.verify(token)).rejects.toMatchObject({ code: "AUTH_TOKEN_EXPIRED" })
	})

	test("foreign signatures fail with AUTH_TOKEN_INVALID", async () => {
		const { privateKey } = await generateKeyPair("ES256")
		const forged = await new SignJWT({ ...input })
			.setProtectedHeader({ alg: "ES256", kid: keys.jwks().keys[0]!.kid, typ: "at+jwt" })
			.setIssuer(t.config.issuer)
			.setIssuedAt()
			.setExpirationTime("10m")
			.sign(privateKey)
		const error = await keys.verify(forged).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(GezcezError)
		expect((error as GezcezError).code).toBe("AUTH_TOKEN_INVALID")
	})

	test("rotation publishes the next key first and activates it after the delay", async () => {
		const before = keys.jwks().keys.map((key) => key.kid)
		const now = new Date()
		const { kid } = await keys.rotate(now)
		expect(keys.jwks().keys.map((key) => key.kid)).toEqual([...before, kid])

		// Still signed with the old key until the new one is active.
		const oldToken = await keys.sign(input, 900, now)
		expect(decodeProtectedHeader(oldToken).kid).toBe(before[0])

		const later = new Date(now.getTime() + 25 * 3600_000)
		const newToken = await keys.sign(input, 900, later)
		expect(decodeProtectedHeader(newToken).kid).toBe(kid)
		// Tokens from the previous key stay valid while it is published.
		expect((await keys.verify(oldToken, new Date(now.getTime() + 60_000))).sub).toBe(input.sub)
	})
})

describe("well-known endpoints", () => {
	test("GET /.well-known/jwks.json is raw and cacheable", async () => {
		const res = await t.json<{ keys: { kid: string }[] }>("/.well-known/jwks.json")
		expect(res.status).toBe(200)
		expect(res.headers.get("cache-control")).toBe("public, max-age=300")
		expect(res.body.keys.length).toBeGreaterThan(0)
	})

	test("GET /.well-known/openid-configuration points at the oauth UI and the API", async () => {
		const res = await t.json<Record<string, unknown>>("/.well-known/openid-configuration")
		expect(res.status).toBe(200)
		expect(res.body.issuer).toBe(t.config.issuer)
		expect(res.body.authorization_endpoint).toBe(`${t.config.oauthUiUrl}/authorize`)
		expect(res.body.token_endpoint).toBe(`${t.config.publicApiUrl}/v1/oauth/token`)
		expect(res.body.code_challenge_methods_supported).toEqual(["S256"])
	})

	test("/ready includes the signing key", async () => {
		const res = await t.json<{ checks: { name: string; ok: boolean }[] }>("/ready")
		expect(res.body.checks).toContainEqual({ name: "signing_key", ok: true })
	})
})
