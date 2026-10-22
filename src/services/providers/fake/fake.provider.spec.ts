import { describe, expect, test } from "bun:test"
import type { BindingContext } from "../transit-provider.interface"
import { FakeProvider } from "./fake.provider"

const BINDING: BindingContext = {
	id: 3,
	networkId: 1,
	providerKey: "fake",
	externalRef: "x",
	config: {},
	bbox: null,
	timezone: "Europe/Istanbul",
}
// A Wednesday at 12:00 Istanbul time, inside the service day.
const NOON = Date.parse("2026-10-21T09:00:00Z")

describe("FakeProvider vehicles option", () => {
	test("keeps the timetable fleet by default", () => {
		const feed = new FakeProvider(() => NOON).synthetic(BINDING, NOON / 1000)
		expect(feed.entities.length).toBeGreaterThan(0)
		expect(feed.entities.length).toBeLessThan(20)
	})

	test("pads every feed to the requested size with unique, moving vehicles", () => {
		const provider = new FakeProvider(() => NOON, { vehicles: 2000 })
		const a = provider.synthetic(BINDING, NOON / 1000)
		const b = provider.synthetic(BINDING, NOON / 1000 + 15)
		expect(a.entities).toHaveLength(2000)
		expect(new Set(a.entities.map((v) => v.externalId)).size).toBe(2000)
		const before = a.entities.find((v) => v.externalId === "X00042")!
		const after = b.entities.find((v) => v.externalId === "X00042")!
		expect([after.lat, after.lon]).not.toEqual([before.lat, before.lon])
		expect(a.entities.every((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon))).toBe(true)
	})
})
