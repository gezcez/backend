import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestApp, type TestApp } from "@test/helpers/app"
import { sha256Hex } from "@common/utils"
import { DatabaseService } from "@db"
import { emailSuppressionsTable } from "@schemas/core"
import { EmailRepository } from "./email.repository"
import { EmailService, MAX_EMAIL_ATTEMPTS } from "./email.service"
import { renderTemplate } from "./email.templates"
import { MemoryTransport } from "./email.transports"

describe("email templates", () => {
	test("code emails carry the code in text, html and subject in both locales", () => {
		for (const locale of ["tr", "en"] as const) {
			const email = renderTemplate("signin_code", locale, { code: "123456", minutes: 10 })
			expect(email.subject).toContain("123456")
			expect(email.text).toContain("123456")
			expect(email.html).toContain("123456")
			expect(email.text).toContain("10")
		}
		expect(renderTemplate("signin_code", "tr", { code: "1", minutes: 10 }).subject).toContain(
			"giriş",
		)
		expect(renderTemplate("signin_code", "en", { code: "1", minutes: 10 }).subject).toContain(
			"sign-in",
		)
	})

	test("html escapes values and uses the brand colours", () => {
		const email = renderTemplate("signup_code", "en", { code: "<b>", minutes: 10 })
		expect(email.html).not.toContain("<b>")
		expect(email.html).toContain("#fffbeb")
		expect(email.html).toContain("#172554")
	})
})

describe("EmailService", () => {
	let t: TestApp
	let email: EmailService
	let transport: MemoryTransport
	let repository: EmailRepository

	beforeAll(async () => {
		t = await createTestApp()
		email = t.app.get(EmailService)
		repository = t.app.get(EmailRepository)
		transport = email.transport as MemoryTransport
		email.retryDelayMs = () => 1
	})
	afterAll(async () => {
		await t.close()
	})

	test("sends through the memory transport and never stores the code", async () => {
		const { id, done } = email.send("signin_code", "Someone@Example.com", "en", {
			code: "654321",
			minutes: 10,
		})
		await done
		const row = repository.findById(id)!
		expect(row.status).toBe("sent")
		expect(row.to_email).toBe("someone@example.com")
		expect(row.subject).not.toContain("654321")
		expect(row.subject).toContain("******")
		expect(transport.for("someone@example.com").at(-1)?.code).toBe("654321")
	})

	test("retries failed sends with backoff until one succeeds", async () => {
		transport.failNext = 2
		const { id, done } = email.send("password_changed", "retry@example.com", "tr", {})
		await done
		await Bun.sleep(50)
		const row = repository.findById(id)!
		expect(row.status).toBe("sent")
		expect(row.attempts).toBe(3)
	})

	test("gives up after the last attempt", async () => {
		transport.failNext = MAX_EMAIL_ATTEMPTS
		const { id, done } = email.send("password_changed", "broken@example.com", "tr", {})
		await done
		await Bun.sleep(100)
		const row = repository.findById(id)!
		expect(row.status).toBe("failed")
		expect(row.attempts).toBe(MAX_EMAIL_ATTEMPTS)
		expect(row.last_error).toContain("simulated failure")
	})

	test("suppressed addresses are not sent to", async () => {
		t.app
			.get(DatabaseService)
			.core.insert(emailSuppressionsTable)
			.values({
				email_hash: sha256Hex("bounced@example.com"),
				reason: "bounce",
				created_at: new Date(),
			})
			.run()
		const { id, done } = email.send("password_changed", "Bounced@example.com", "en", {})
		await done
		expect(repository.findById(id)?.status).toBe("failed")
		expect(transport.for("bounced@example.com")).toEqual([])
	})

	test("GET /v1/__test/mailbox returns messages for one address", async () => {
		await email.send("signup_code", "mailbox@example.com", "en", {
			code: "111222",
			minutes: 10,
		}).done
		const res = await t.json<{
			ok: true
			data: { messages: { code: string; template: string }[] }
		}>("/v1/__test/mailbox?to=MAILBOX@example.com")
		expect(res.status).toBe(200)
		expect(res.body.data.messages).toHaveLength(1)
		expect(res.body.data.messages[0]).toMatchObject({ code: "111222", template: "signup_code" })
	})
})

describe("test mailbox outside tests", () => {
	test("is not registered when NODE_ENV is not test", async () => {
		const t = await createTestApp({ NODE_ENV: "development", EMAIL_TRANSPORT: "console" })
		try {
			const res = await t.fetch("/v1/__test/mailbox?to=a@b.c")
			expect(res.status).toBe(404)
		} finally {
			await t.close()
		}
	})
})
