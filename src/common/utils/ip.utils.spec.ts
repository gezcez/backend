import { describe, expect, test } from "bun:test"
import type { Request } from "express"
import { clientIp, hashIp, ipPrefix } from "./ip.utils"

function req(headers: Record<string, string | string[]>, remoteAddress?: string): Request {
	return { headers, socket: remoteAddress === undefined ? undefined : { remoteAddress } } as never
}

describe("clientIp", () => {
	test("trusts CF-Connecting-IP only behind the tunnel", () => {
		const r = req({ "cf-connecting-ip": " 203.0.113.7 " }, "10.0.0.1")
		expect(clientIp(r, true)).toBe("203.0.113.7")
		expect(clientIp(r, false)).toBe("10.0.0.1")
	})

	test("takes the first value of a repeated header", () => {
		expect(clientIp(req({ "cf-connecting-ip": ["198.51.100.1", "1.1.1.1"] }), true)).toBe(
			"198.51.100.1",
		)
	})

	test("falls back to the socket, strips the IPv4-mapped prefix", () => {
		expect(clientIp(req({}, "::ffff:192.0.2.5"), true)).toBe("192.0.2.5")
		expect(clientIp(req({ "cf-connecting-ip": "" }, "2001:db8::1"), true)).toBe("2001:db8::1")
		expect(clientIp(req({}), false)).toBe("unknown")
	})
})

describe("hashIp", () => {
	test("is stable within a UTC day and changes across days and secrets", () => {
		const day = new Date("2026-03-01T01:00:00Z")
		const later = new Date("2026-03-01T23:00:00Z")
		const next = new Date("2026-03-02T00:00:01Z")
		const a = hashIp("192.0.2.5", "s", day)
		expect(a).toHaveLength(32)
		expect(hashIp("192.0.2.5", "s", later)).toBe(a)
		expect(hashIp("192.0.2.5", "s", next)).not.toBe(a)
		expect(hashIp("192.0.2.5", "t", day)).not.toBe(a)
		expect(hashIp("192.0.2.6", "s", day)).not.toBe(a)
	})
})

describe("ipPrefix", () => {
	test("/24 for IPv4 and /48 for IPv6", () => {
		expect(ipPrefix("192.0.2.5")).toBe("192.0.2.0/24")
		expect(ipPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48")
	})

	test("returns anything else unchanged", () => {
		expect(ipPrefix("1.2.3")).toBe("1.2.3")
		expect(ipPrefix("unknown")).toBe("unknown")
	})
})
