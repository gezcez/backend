import { describe, expect, test } from "bun:test"
import {
	newId,
	randomDigits,
	randomToken,
	safeEqual,
	seal,
	signToken,
	unseal,
	verifyToken,
} from "./crypto.utils"
import { hashIp, ipPrefix } from "./ip.utils"

const SECRET = "s".repeat(32)

describe("crypto utils", () => {
	test("randomDigits gives the requested length of digits", () => {
		for (let i = 0; i < 50; i++) expect(randomDigits(6)).toMatch(/^\d{6}$/)
	})

	test("randomToken is url safe and long enough", () => {
		expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})

	test("newId adds the prefix to a ULID", () => {
		expect(newId("ar")).toMatch(/^ar_[0-9A-HJKMNP-TV-Z]{26}$/)
		expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
	})

	test("safeEqual", () => {
		expect(safeEqual("abc", "abc")).toBe(true)
		expect(safeEqual("abc", "abd")).toBe(false)
		expect(safeEqual("abc", "abcd")).toBe(false)
	})

	test("seal and unseal round trip, and purposes do not mix", () => {
		const sealed = seal(SECRET, "a", "hello")
		expect(unseal(SECRET, "a", sealed)).toBe("hello")
		expect(() => unseal(SECRET, "b", sealed)).toThrow()
		expect(() => unseal("t".repeat(32), "a", sealed)).toThrow()
	})

	test("signed tokens verify, expire and resist tampering", () => {
		const token = signToken(SECRET, "profile", { email: "a@b.c" }, 60_000)
		expect(verifyToken<{ email: string }>(SECRET, "profile", token)?.email).toBe("a@b.c")
		expect(verifyToken(SECRET, "reset", token)).toBeNull()
		expect(verifyToken(SECRET, "profile", `${token}x`)).toBeNull()
		expect(verifyToken(SECRET, "profile", signToken(SECRET, "profile", {}, -1))).toBeNull()
	})
})

describe("ip utils", () => {
	test("ipPrefix truncates to /24 and /48", () => {
		expect(ipPrefix("88.230.12.7")).toBe("88.230.12.0/24")
		expect(ipPrefix("2a02:4780:1:2:3:4:5:6")).toBe("2a02:4780:1::/48")
	})

	test("hashIp changes with the day", () => {
		const a = hashIp("1.2.3.4", SECRET, new Date("2026-01-01T10:00:00Z"))
		const b = hashIp("1.2.3.4", SECRET, new Date("2026-01-01T23:00:00Z"))
		const c = hashIp("1.2.3.4", SECRET, new Date("2026-01-02T10:00:00Z"))
		expect(a).toBe(b)
		expect(a).not.toBe(c)
	})
})
