import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { RateLimitService } from "@common/rate-limits"
import { createTestApp, type TestApp } from "../helpers/app"

let t: TestApp

beforeAll(async () => {
	// public-read becomes 3 per minute, email-code-send 1 per email per hour.
	t = await createTestApp({ RATE_LIMIT_SCALE: "0.01" })
})
afterAll(async () => {
	await t.close()
})

describe("rate limiting", () => {
	test("the global public-read limit answers 429 RATE_LIMITED with retry_after", async () => {
		const statuses: number[] = []
		let last:
			{ ok: boolean; error: { code: string; details: { retry_after: number } } } | undefined
		for (let i = 0; i < 4; i++) {
			const res = await t.json<typeof last>("/v1/__test/mailbox?to=nobody@example.com")
			statuses.push(res.status)
			last = res.body
		}
		expect(statuses).toEqual([200, 200, 200, 429])
		expect(last?.ok).toBe(false)
		expect(last?.error.code).toBe("RATE_LIMITED")
		expect(last?.error.details.retry_after).toBeGreaterThan(0)
		expect(last?.error.details.retry_after).toBeLessThanOrEqual(60)
	})

	test("probes are never throttled", async () => {
		for (let i = 0; i < 6; i++) expect((await t.fetch("/health")).status).toBe(200)
	})

	test("per-email presets count separately from the IP", async () => {
		const limits = t.app.get(RateLimitService)
		await limits.consume("email-code-send", { email: "a@example.com" }, { only: ["email"] })
		const error = await limits
			.consume("email-code-send", { email: "A@example.com" }, { only: ["email"] })
			.catch((e: unknown) => e)
		expect(error).toMatchObject({ code: "RATE_LIMITED" })
		expect((error as { details: { retry_after: number } }).details.retry_after).toBeGreaterThan(
			3000,
		)
		// Another address is unaffected.
		await limits.consume("email-code-send", { email: "b@example.com" }, { only: ["email"] })
	})
})
