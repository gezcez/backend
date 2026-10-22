import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createTestApp, type TestApp } from "@test/helpers/app"
import { DatabaseService } from "@db"
import { auditLogTable } from "@schemas/core"
import { AuditRepository } from "./audit.repository"

let t: TestApp
let repository: AuditRepository

beforeAll(async () => {
	t = await createTestApp()
	repository = t.app.get(AuditRepository)
})
afterAll(async () => {
	await t.close()
})

const db = () => t.app.get(DatabaseService).core

function insert(row: Partial<typeof auditLogTable.$inferInsert>): number {
	return db()
		.insert(auditLogTable)
		.values({ at: new Date(), action: "auth.login", ...row })
		.returning({ id: auditLogTable.id })
		.get().id
}

describe("AuditRepository.anonymiseUser", () => {
	test("rewrites rows where the user is the actor or the target", () => {
		const asActor = insert({ actor_user_id: 9001, data: { reason: "x" } })
		const asActorNoData = insert({ actor_user_id: 9001 })
		const asTarget = insert({ actor_user_id: 1, target_type: "user", target_id: "9001" })
		const otherType = insert({ target_type: "app", target_id: "9001" })
		const otherUser = insert({ actor_user_id: 9002, target_type: "user", target_id: "9002" })

		expect(repository.anonymiseUser(9001, "deleted_abc")).toBe(3)

		const get = (id: number) =>
			db().select().from(auditLogTable).where(eq(auditLogTable.id, id)).get()!
		expect(get(asActor)).toMatchObject({
			actor_user_id: null,
			data: { reason: "x", actor_tombstone: "deleted_abc" },
		})
		expect(get(asActorNoData)).toMatchObject({
			actor_user_id: null,
			data: { actor_tombstone: "deleted_abc" },
		})
		expect(get(asTarget)).toMatchObject({ actor_user_id: 1, target_id: "deleted_abc" })
		expect(get(otherType).target_id).toBe("9001")
		expect(get(otherUser)).toMatchObject({ actor_user_id: 9002, target_id: "9002" })
	})

	test("returns 0 when the user has no rows", () => {
		expect(repository.anonymiseUser(424242, "deleted_none")).toBe(0)
	})
})
