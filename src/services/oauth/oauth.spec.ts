import { describe, expect, test } from "bun:test"
import {
	matchRedirectUri,
	parseBasicAuth,
	parseMaxAge,
	parsePrompt,
	pkceChallenge,
	withQuery,
} from "./oauth.utils"

describe("matchRedirectUri", () => {
	const registered = ["https://dash.gezcez.com/auth/callback", "http://localhost:4710/callback"]

	test("matches byte for byte", () => {
		expect(matchRedirectUri(registered, "https://dash.gezcez.com/auth/callback", false)).toBe(
			true,
		)
		expect(matchRedirectUri(registered, "https://dash.gezcez.com/auth/callback/", false)).toBe(
			false,
		)
		expect(matchRedirectUri(registered, "https://DASH.gezcez.com/auth/callback", false)).toBe(
			false,
		)
		expect(
			matchRedirectUri(registered, "https://dash.gezcez.com/auth/callback?x=1", false),
		).toBe(false)
	})

	test("dev clients may change only the loopback port", () => {
		expect(matchRedirectUri(registered, "http://localhost:5173/callback", false)).toBe(false)
		expect(matchRedirectUri(registered, "http://localhost:5173/callback", true)).toBe(true)
		expect(matchRedirectUri(registered, "http://localhost/callback", true)).toBe(true)
		expect(matchRedirectUri(registered, "http://localhost:5173/other", true)).toBe(false)
		expect(matchRedirectUri(registered, "http://127.0.0.1:5173/callback", true)).toBe(false)
		expect(matchRedirectUri(registered, "http://localhost.evil.com:5173/callback", true)).toBe(
			false,
		)
		expect(matchRedirectUri(registered, "http://localhost:5173/callback#x", true)).toBe(false)
	})
})

describe("PKCE", () => {
	test("RFC 7636 appendix B vector", () => {
		expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		)
	})
})

describe("parameter parsing", () => {
	test("prompt", () => {
		expect(parsePrompt(undefined)).toEqual([])
		expect(parsePrompt("login consent")).toEqual(["login", "consent"])
		expect(parsePrompt("none login")).toBeNull()
		expect(parsePrompt("bogus")).toBeNull()
	})

	test("max_age", () => {
		expect(parseMaxAge(undefined)).toBeUndefined()
		expect(parseMaxAge("600")).toBe(600)
		expect(parseMaxAge("-1")).toBeNull()
		expect(parseMaxAge("1e3")).toBeNull()
	})

	test("withQuery keeps the existing query", () => {
		expect(withQuery("gezcez://cb?a=1", { code: "x y", state: undefined })).toBe(
			"gezcez://cb?a=1&code=x+y",
		)
	})

	test("basic auth", () => {
		const header = `Basic ${Buffer.from("my%20app:s%3Acret").toString("base64")}`
		expect(parseBasicAuth(header)).toEqual({ clientId: "my app", secret: "s:cret" })
		expect(parseBasicAuth("Bearer x")).toBeNull()
	})
})
