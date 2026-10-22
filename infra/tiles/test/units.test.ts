import { describe, expect, it } from "vitest"
import { isAllowedOrigin, parseOrigins } from "../src/cors"
import { etagMatches, parseRange } from "../src/http"

describe("parseRange", () => {
	it.each([
		[null, undefined],
		["bytes=0-9", { offset: 0, length: 10 }],
		["bytes=90-", { offset: 90, length: 10 }],
		["bytes=95-200", { offset: 95, length: 5 }],
		["bytes=-5", { offset: 95, length: 5 }],
		["bytes=-500", { offset: 0, length: 100 }],
		["bytes=100-", "unsatisfiable"],
		["bytes=9-3", "unsatisfiable"],
		["bytes=0-1,4-5", "unsatisfiable"],
		["bytes=-", "unsatisfiable"],
		["items=0-1", undefined],
	])("%s", (header, expected) => {
		expect(parseRange(header, 100)).toEqual(expected)
	})
})

describe("isAllowedOrigin", () => {
	const patterns = parseOrigins(
		" https://gezcez.com/, https://*.gezcez.com,http://localhost:5173",
	)
	it.each([
		["https://gezcez.com", true],
		["https://dash.gezcez.com", true],
		["https://dash-staging.gezcez.com", true],
		["http://localhost:5173", true],
		["https://a.b.gezcez.com", false],
		["https://evilgezcez.com", false],
		["https://gezcez.com.evil.example", false],
		["http://dash.gezcez.com", false],
		["https://-x.gezcez.com", false],
	])("%s is %s", (origin, allowed) => {
		expect(isAllowedOrigin(origin, patterns)).toBe(allowed)
	})
})

describe("etagMatches", () => {
	it("compares strong and weak forms and lists", () => {
		expect(etagMatches('"a", W/"b"', '"b"')).toBe(true)
		expect(etagMatches("*", '"x"')).toBe(true)
		expect(etagMatches('"a"', '"b"')).toBe(false)
		expect(etagMatches(null, '"b"')).toBe(false)
	})
})
