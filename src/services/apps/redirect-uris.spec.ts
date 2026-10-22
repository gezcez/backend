import { describe, expect, test } from "bun:test"
import { redirectUriProblem, redirectUriProblems } from "./redirect-uris"

describe("redirect URI rules", () => {
	test("https everywhere; loopback http only for dev; custom schemes only for native", () => {
		expect(redirectUriProblem("https://app.example.com/cb", "web")).toBeNull()
		expect(redirectUriProblem("http://app.example.com/cb", "web")).toBe("https_required")
		expect(redirectUriProblem("http://localhost:5173/cb", "dev")).toBeNull()
		expect(redirectUriProblem("http://localhost/cb", "dev")).toBe("https_required")
		expect(redirectUriProblem("http://localhost:5173/cb", "web")).toBe("https_required")
		expect(redirectUriProblem("gezcez://oauth/callback", "native")).toBeNull()
		expect(redirectUriProblem("gezcez://oauth/callback", "web")).toBe(
			"custom_scheme_native_only",
		)
	})

	test("no wildcards, fragments, garbage or duplicates", () => {
		expect(redirectUriProblem("https://*.example.com/cb", "web")).toBe("wildcard")
		expect(redirectUriProblem("https://example.com/cb#x", "web")).toBe("fragment")
		expect(redirectUriProblem("not a url", "web")).toBe("invalid")
		expect(
			redirectUriProblems(["https://a.example/cb", "https://a.example/cb"], "web"),
		).toEqual(["https://a.example/cb: duplicate"])
	})
})
