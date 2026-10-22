import { describe, expect, test } from "bun:test"
import { testConfig } from "@test/helpers/app"
import { RefreshGraceService } from "./refresh-grace.service"

const config = testConfig("/tmp/unused")
const windowMs = config.refreshGraceS * 1000

describe("RefreshGraceService", () => {
	test("returns the successor while the window is open", () => {
		const grace = new RefreshGraceService(config)
		grace.remember("pred", "successor-token", 1_000)
		expect(grace.successor("pred", 1_000 + windowMs)).toBe("successor-token")
		expect(grace.successor("other", 1_000)).toBeUndefined()
	})

	test("forgets the successor once the window closes", () => {
		const grace = new RefreshGraceService(config)
		grace.remember("pred", "successor-token", 1_000)
		expect(grace.successor("pred", 1_001 + windowMs)).toBeUndefined()
		expect(grace.size).toBe(0)
	})

	test("prunes expired entries when remembering new ones", () => {
		const grace = new RefreshGraceService(config)
		grace.remember("a", "1", 1_000)
		grace.remember("b", "2", 1_000)
		grace.remember("c", "3", 1_001 + windowMs)
		expect(grace.size).toBe(1)
		expect(grace.successor("c", 1_001 + windowMs)).toBe("3")
	})

	test("never keeps the plaintext in memory", () => {
		const grace = new RefreshGraceService(config)
		grace.remember("pred", "plain-successor", 1_000)
		const entries = (grace as unknown as { entries: Map<string, { sealed: string }> }).entries
		expect(entries.get("pred")!.sealed).not.toContain("plain-successor")
	})
})
