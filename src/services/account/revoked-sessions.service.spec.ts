import { describe, expect, test } from "bun:test"
import { REVOKED_SID_WINDOW_MS, RevokedSessionsService } from "./revoked-sessions.service"
import type { SessionRepository } from "./session.repository"

function service(rows: { id: string; revoked_at: Date }[] = []) {
	const asked: Date[] = []
	const repository = {
		revokedSince: (since: Date) => {
			asked.push(since)
			return rows
		},
	} as unknown as SessionRepository
	return { revoked: new RevokedSessionsService(repository), asked }
}

describe("RevokedSessionsService", () => {
	test("loads sessions revoked within the window at boot", () => {
		const { revoked, asked } = service([{ id: "s1", revoked_at: new Date() }])
		const before = Date.now()
		revoked.onModuleInit()
		expect(revoked.has("s1")).toBe(true)
		expect(revoked.size).toBe(1)
		expect(before - asked[0]!.getTime()).toBeGreaterThanOrEqual(REVOKED_SID_WINDOW_MS - 5)
		expect(before - asked[0]!.getTime()).toBeLessThanOrEqual(REVOKED_SID_WINDOW_MS + 5)
	})

	test("prunes entries older than the window on add", () => {
		const { revoked } = service()
		revoked.add(["old"], 1_000)
		revoked.add(["fresh"], 1_000 + REVOKED_SID_WINDOW_MS)
		expect(revoked.has("old")).toBe(true)
		revoked.add(["newest"], 1_001 + REVOKED_SID_WINDOW_MS)
		expect(revoked.has("old")).toBe(false)
		expect(revoked.has("fresh")).toBe(true)
		expect(revoked.has("newest")).toBe(true)
		expect(revoked.size).toBe(2)
	})

	test("unknown ids are not revoked", () => {
		expect(service().revoked.has("nope")).toBe(false)
	})
})
