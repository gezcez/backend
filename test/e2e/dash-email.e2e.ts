import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sha256Hex } from "@common/utils"
import { emailSuppressionsTable, emailsTable } from "@schemas/core"
import { EmailService } from "@services/email/email.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { DashClient, FIXTURE } from "../helpers/dash"

let t: TestApp
let dash: DashClient

beforeAll(async () => {
	t = await createTestApp()
	dash = new DashClient(t)
})
afterAll(async () => {
	await t.close()
})

interface Page<T> {
	items: T[]
	next_cursor: string | null
	total: number | null
}
interface Delivery {
	id: string
	template: string
	subject: string
	to_masked: string
	status: string
	user: { id: string } | null
}

describe("email templates", () => {
	test("lists templates with locales and sample variables, previews server-side", async () => {
		const list = await dash.get<
			{ key: string; locales: string[]; variables: { name: string }[] }[]
		>(FIXTURE.admin, "/v1/dash/email/templates")
		expect(list.status).toBe(200)
		const signin = list.body.data.find((tpl) => tpl.key === "signin_code")!
		expect(signin.locales).toEqual(["tr", "en"])
		expect(signin.variables.map((v) => v.name)).toEqual(["code", "minutes"])
		expect(list.body.data.map((tpl) => tpl.key)).toContain("deletion_scheduled")

		const preview = await dash.call<{ subject: string; text: string; html: string }>(
			FIXTURE.admin,
			"POST",
			"/v1/dash/email/templates/signin_code/preview",
			{ locale: "en", variables: { code: "135790" } },
		)
		expect(preview.body.data.subject).toContain("135790")
		expect(preview.body.data.text).toContain("10 minutes")
		expect(preview.body.data.html).toContain("#fffbeb")

		const missing = await dash.call(
			FIXTURE.admin,
			"POST",
			"/v1/dash/email/templates/nope/preview",
			{ locale: "en" },
		)
		expect(missing.status).toBe(404)
		expect((await dash.get(FIXTURE.moderator, "/v1/dash/email/templates")).status).toBe(403)
	})
})

describe("test sends and deliveries", () => {
	test("sends to the caller's own address; any address needs email.test.send.any", async () => {
		await dash.grantCustomRole(FIXTURE.analyst, "mailer", ["email.read", "email.test.send"])
		const own = await dash.call<{ delivery_id: string; to_masked: string }>(
			FIXTURE.analyst,
			"POST",
			"/v1/dash/email/test",
			{ template: "password_changed", locale: "tr" },
		)
		expect(own.status).toBe(200)
		expect(own.body.data.to_masked).toBe("a***@test.gezcez.com")
		const any = await dash.call(FIXTURE.analyst, "POST", "/v1/dash/email/test", {
			template: "password_changed",
			locale: "tr",
			to: "someone@example.com",
		})
		expect(any.body.error).toMatchObject({
			code: "PERMISSION_MISSING",
			details: { permission: "email.test.send.any" },
		})

		const admin = await dash.call<{ delivery_id: string }>(
			FIXTURE.admin,
			"POST",
			"/v1/dash/email/test",
			{ template: "signin_code", locale: "en", to: "Outside@Example.com" },
		)
		expect(admin.status).toBe(200)

		const deliveries = await dash.get<Page<Delivery>>(
			FIXTURE.admin,
			"/v1/dash/email/deliveries?template=signin_code&q=TEST",
		)
		const row = deliveries.body.data.items.find((d) => d.id === admin.body.data.delivery_id)!
		expect(row).toMatchObject({
			to_masked: "o***@example.com",
			status: "sent",
			user: null,
		})
		// The code never reaches the log, not even inside the subject.
		expect(row.subject).toBe("[TEST] Your gezcez sign-in code: ******")

		const mine = await dash.get<Page<Delivery>>(
			FIXTURE.admin,
			`/v1/dash/users/${dash.publicId(FIXTURE.analyst)}/emails`,
		)
		expect(mine.body.data.items.map((d) => d.id)).toContain(own.body.data.delivery_id)
		expect(mine.body.data.items[0]!.user!.id).toBe(dash.publicId(FIXTURE.analyst))

		const bad = await dash.get(FIXTURE.admin, "/v1/dash/email/deliveries?sort=subject:asc")
		expect(bad.body.error.code).toBe("VALIDATION_FAILED")
		const audit = await dash.get<Page<{ action: string }>>(
			FIXTURE.admin,
			"/v1/dash/audit?action=email.test_sent",
		)
		expect(audit.body.data.items.length).toBeGreaterThanOrEqual(2)
	})
})

describe("suppressions", () => {
	test("lists active suppressions masked and removes one with a reason", async () => {
		const hash = sha256Hex("bounced@example.com")
		dash.db
			.insert(emailSuppressionsTable)
			.values({
				email_hash: hash,
				reason: "bounce",
				email_masked: "b***@example.com",
				detail: "550 mailbox unavailable",
				created_at: new Date(),
			})
			.run()
		const list = await dash.get<Page<{ id: string; email_masked: string; reason: string }>>(
			FIXTURE.admin,
			"/v1/dash/email/suppressions?q=b***",
		)
		expect(list.body.data.items).toContainEqual(
			expect.objectContaining({
				id: hash,
				email_masked: "b***@example.com",
				reason: "bounce",
			}),
		)

		// Suppressed addresses are not sent to.
		const send = t.app
			.get(EmailService)
			.send("password_changed", "bounced@example.com", "en", {})
		await send.done
		const row = dash.db
			.select()
			.from(emailsTable)
			.all()
			.find((e) => e.id === send.id)!
		expect(row.status).toBe("failed")
		expect(row.last_error).toBe("suppressed")

		expect(
			(
				await dash.call(FIXTURE.analyst, "DELETE", `/v1/dash/email/suppressions/${hash}`, {
					reason: "fixed mailbox",
				})
			).status,
		).toBe(403)
		const removed = await dash.call<{ deleted: boolean }>(
			FIXTURE.admin,
			"DELETE",
			`/v1/dash/email/suppressions/${hash}`,
			{ reason: "fixed mailbox" },
		)
		expect(removed.body.data.deleted).toBe(true)
		const again = await dash.call(
			FIXTURE.admin,
			"DELETE",
			`/v1/dash/email/suppressions/${hash}`,
			{
				reason: "fixed mailbox",
			},
		)
		expect(again.status).toBe(404)
		const after = await dash.get<Page<{ id: string }>>(
			FIXTURE.admin,
			"/v1/dash/email/suppressions",
		)
		expect(after.body.data.items.map((s) => s.id)).not.toContain(hash)
	})
})
