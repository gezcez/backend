import { describe, expect, test } from "bun:test"
import type { AuditLogRow } from "@schemas/core"
import { auditSeverity, presentAudit, redact } from "./audit.presenter"

const row = (patch: Partial<AuditLogRow>): AuditLogRow => ({
	id: 1,
	at: new Date("2026-10-01T00:00:00Z"),
	actor_user_id: null,
	actor_client_id: null,
	action: "auth.login",
	target_type: null,
	target_id: null,
	network_id: null,
	request_id: null,
	ip_hash: null,
	data: null,
	...patch,
})
const lookups = {
	users: new Map([[7, { id: "01USER", display_name: "Ada", username: null }]]),
	apps: new Map([["mobile", "gezcez"]]),
	networks: new Map(),
	roles: new Map(),
}

describe("audit presenter", () => {
	test("severity by action", () => {
		expect(auditSeverity("auth.login")).toBe("info")
		expect(auditSeverity("moderation.ban")).toBe("warn")
		expect(auditSeverity("apps.secret_rotated")).toBe("critical")
	})

	test("redacts sensitive keys at any depth", () => {
		expect(
			redact({ role: "viewer", new_email: "a@b.c", nested: [{ client_secret: "x" }] }),
		).toEqual({
			role: "viewer",
			new_email: "[redacted]",
			nested: [{ client_secret: "[redacted]" }],
		})
	})

	test("users appear by public id and name; data without a diff becomes `after`", () => {
		const entry = presentAudit(
			row({ actor_user_id: 7, target_type: "user", target_id: "7", data: { method: "otp" } }),
			lookups,
		)
		expect(entry).toMatchObject({
			actor: { id: "01USER" },
			target_id: "01USER",
			target_label: "Ada",
			before: null,
			after: { method: "otp" },
		})
		const diff = presentAudit(
			row({
				target_type: "app",
				target_id: "mobile",
				data: { before: { a: 1 }, after: { a: 2 } },
			}),
			lookups,
		)
		expect(diff).toMatchObject({ target_label: "gezcez", before: { a: 1 }, after: { a: 2 } })
	})

	test("unknown or deleted users are not leaked as internal ids", () => {
		expect(
			presentAudit(row({ target_type: "user", target_id: "99" }), lookups).target_id,
		).toBeNull()
		expect(
			presentAudit(row({ target_type: "user", target_id: "del_abc" }), lookups).target_id,
		).toBe("del_abc")
	})
})
