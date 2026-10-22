import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestApp, type TestApp } from "@test/helpers/app"
import { PageQuerySchema } from "@common/response"
import { EmailAdminRepository } from "./email-admin.repository"

let t: TestApp
let repository: EmailAdminRepository

beforeAll(async () => {
	t = await createTestApp()
	repository = t.app.get(EmailAdminRepository)
})
afterAll(async () => {
	await t.close()
})

const page = PageQuerySchema.parse({ limit: 50 })

describe("EmailAdminRepository.suppress", () => {
	test("adds a suppression that is listed and found as active", () => {
		repository.suppress({
			email_hash: "hash-1",
			email_masked: "b***@example.com",
			reason: "bounce",
			detail: "550 mailbox unavailable",
			now: new Date(1_700_000_000_000),
		})
		expect(repository.findActiveSuppression("hash-1")).toMatchObject({
			email_masked: "b***@example.com",
			reason: "bounce",
			detail: "550 mailbox unavailable",
			removed_at: null,
		})
		expect(
			repository.suppressions({}, page).items.map((row) => row.email_hash),
		).toContain("hash-1")
	})

	test("re-activates a removed suppression with the new reason", () => {
		repository.suppress({
			email_hash: "hash-2",
			email_masked: "c***@example.com",
			reason: "bounce",
			detail: null,
			now: new Date(1_700_000_000_000),
		})
		expect(repository.removeSuppression("hash-2", 1, "fixed mailbox", new Date())).toBe(true)
		expect(repository.findActiveSuppression("hash-2")).toBeUndefined()
		expect(repository.removeSuppression("hash-2", 1, "again", new Date())).toBe(false)

		repository.suppress({
			email_hash: "hash-2",
			email_masked: "c***@example.com",
			reason: "complaint",
			detail: "abuse report",
			now: new Date(1_700_000_100_000),
		})
		expect(repository.findActiveSuppression("hash-2")).toMatchObject({
			reason: "complaint",
			detail: "abuse report",
			removed_at: null,
			removed_by: null,
			removed_reason: null,
		})
		expect(
			repository
				.suppressions({ reason: "complaint" }, page)
				.items.map((row) => row.email_hash),
		).toEqual(["hash-2"])
	})

	test("userEmail is undefined for an unknown user", () => {
		expect(repository.userEmail(987654)).toBeUndefined()
	})
})
