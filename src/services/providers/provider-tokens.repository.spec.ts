import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createTestApp, type TestApp } from "@test/helpers/app"
import { DatabaseService } from "@db"
import { providerTokensTable } from "@schemas/vts"
import { ProviderTokensRepository } from "./provider-tokens.repository"

// TRACKER_RUNNER=manual makes this process own vts.db, so tokens are persisted there.
let t: TestApp
let tokens: ProviderTokensRepository

beforeAll(async () => {
	t = await createTestApp({ TRACKER_RUNNER: "manual" })
	tokens = t.app.get(ProviderTokensRepository)
})
afterAll(async () => {
	await t.close()
})

const row = (realm: string) =>
	t.app
		.get(DatabaseService)
		.vts.select()
		.from(providerTokensTable)
		.where(eq(providerTokensTable.realm, realm))
		.get()

describe("ProviderTokensRepository", () => {
	test("returns undefined for an unknown realm", () => {
		expect(tokens.load("nobody")).toBeUndefined()
	})

	test("seals the token at rest and loads it back", () => {
		const token = { accessToken: "secret-token", expiresAt: 2000, issuedAt: 1000, refreshedAt: 1500 }
		tokens.save("kentkart:kocaeli", token)
		const stored = row("kentkart:kocaeli")!
		expect(stored.access_token_enc).not.toContain("secret-token")
		expect(stored.failures).toBe(0)
		expect(tokens.load("kentkart:kocaeli")).toEqual(token)
	})

	test("records failures and a new save resets them", () => {
		tokens.save("realm-b", { accessToken: "a", expiresAt: 2, issuedAt: 1, refreshedAt: 1 })
		tokens.recordFailure("realm-b", 3)
		expect(row("realm-b")!.failures).toBe(3)
		tokens.save("realm-b", { accessToken: "b", expiresAt: 4, issuedAt: 3, refreshedAt: 3 })
		expect(row("realm-b")!.failures).toBe(0)
		expect(tokens.load("realm-b")!.accessToken).toBe("b")
	})

	test("recording a failure for an unknown realm is a no-op", () => {
		tokens.recordFailure("missing", 1)
		expect(row("missing")).toBeUndefined()
	})

	test("a row that cannot be unsealed behaves as no token", () => {
		tokens.save("realm-c", { accessToken: "c", expiresAt: 2, issuedAt: 1, refreshedAt: 1 })
		t.app
			.get(DatabaseService)
			.vts.update(providerTokensTable)
			.set({ access_token_enc: "garbage" })
			.where(eq(providerTokensTable.realm, "realm-c"))
			.run()
		expect(tokens.load("realm-c")).toBeUndefined()
	})
})
