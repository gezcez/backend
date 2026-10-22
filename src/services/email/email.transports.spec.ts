import { describe, expect, test } from "bun:test"
import type { SendEmailCommand } from "@aws-sdk/client-sesv2"
import { testConfig } from "@test/helpers/app"
import {
	ConsoleTransport,
	createTransport,
	MemoryTransport,
	SesTransport,
	type OutgoingEmail,
} from "./email.transports"

function outgoing(partial: Partial<OutgoingEmail> = {}): OutgoingEmail {
	return {
		id: "em_1",
		to: "rider@example.com",
		from: "gezcez <noreply@gezcez.com>",
		template: "signin_code",
		subject: "Your code",
		text: "Code: 123456",
		html: "<p>Code: 123456</p>",
		vars: { code: "123456" },
		...partial,
	}
}

describe("createTransport", () => {
	test("picks the transport from the config", () => {
		const config = testConfig("/tmp/unused")
		expect(createTransport(config)).toBeInstanceOf(MemoryTransport)
		expect(
			createTransport({ ...config, email: { ...config.email, transport: "console" } }),
		).toBeInstanceOf(ConsoleTransport)
		const ses = createTransport({
			...config,
			email: {
				...config.email,
				transport: "ses",
				ses: { region: "eu-central-1", accessKeyId: "AKIA", secretAccessKey: "secret" },
			},
		})
		expect(ses).toBeInstanceOf(SesTransport)
		expect(ses.name).toBe("ses")
	})
})

describe("ConsoleTransport", () => {
	test("logs the recipient, subject and the whole text body", async () => {
		const transport = new ConsoleTransport()
		const lines: string[] = []
		;(transport as unknown as { logger: { log(line: string): void } }).logger = {
			log: (line) => lines.push(line),
		}
		expect(await transport.send(outgoing())).toEqual({})
		expect(transport.name).toBe("console")
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("To rider@example.com: Your code")
		expect(lines[0]).toContain("Code: 123456")
	})
})

describe("MemoryTransport", () => {
	test("keeps codes only when they are strings, filters by lowercased address", async () => {
		const transport = new MemoryTransport()
		const sent = await transport.send(outgoing())
		expect(sent.providerMessageId).toBe("memory-em_1")
		await transport.send(outgoing({ id: "em_2", vars: { code: 42 } }))
		await transport.send(outgoing({ id: "em_3", to: "other@example.com" }))
		const mine = transport.for("Rider@Example.com")
		expect(mine.map((m) => m.id)).toEqual(["em_1", "em_2"])
		expect(mine[0]!.code).toBe("123456")
		expect(mine[1]!.code).toBeUndefined()
		expect(Date.parse(mine[0]!.sent_at)).not.toBeNaN()
	})

	test("fails the next N sends, then recovers", async () => {
		const transport = new MemoryTransport()
		transport.failNext = 2
		await expect(transport.send(outgoing())).rejects.toThrow("simulated failure")
		await expect(transport.send(outgoing())).rejects.toThrow("simulated failure")
		expect(transport.failNext).toBe(0)
		await transport.send(outgoing())
		expect(transport.messages).toHaveLength(1)
	})

	test("keeps only the newest 1000 messages", async () => {
		const transport = new MemoryTransport()
		for (let i = 0; i < 1005; i++) await transport.send(outgoing({ id: `em_${i}` }))
		expect(transport.messages).toHaveLength(1000)
		expect(transport.messages[0]!.id).toBe("em_5")
		expect(transport.messages.at(-1)!.id).toBe("em_1004")
	})
})

describe("SesTransport", () => {
	function withFakeClient(transport: SesTransport, messageId: string | undefined) {
		const commands: SendEmailCommand[] = []
		;(
			transport as unknown as { client: { send(command: SendEmailCommand): Promise<unknown> } }
		).client = {
			send: async (command) => {
				commands.push(command)
				return { MessageId: messageId }
			},
		}
		return commands
	}

	test("sends text and html as UTF-8 with a template tag", async () => {
		const transport = new SesTransport({ region: "eu-central-1" })
		const commands = withFakeClient(transport, "ses-123")
		const result = await transport.send(outgoing())
		expect(result).toEqual({ providerMessageId: "ses-123" })
		expect(commands).toHaveLength(1)
		expect(commands[0]!.input).toEqual({
			FromEmailAddress: "gezcez <noreply@gezcez.com>",
			Destination: { ToAddresses: ["rider@example.com"] },
			Content: {
				Simple: {
					Subject: { Data: "Your code", Charset: "UTF-8" },
					Body: {
						Text: { Data: "Code: 123456", Charset: "UTF-8" },
						Html: { Data: "<p>Code: 123456</p>", Charset: "UTF-8" },
					},
				},
			},
			EmailTags: [{ Name: "template", Value: "signin_code" }],
		})
	})

	test("uses static credentials only when both parts are set", async () => {
		const withKeys = new SesTransport({
			region: "eu-central-1",
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
		})
		const client = (withKeys as unknown as { client: { config: { credentials(): Promise<{ accessKeyId: string }> } } }).client
		expect((await client.config.credentials()).accessKeyId).toBe("AKIA")
		// Half a key pair falls back to the default chain (no static credentials).
		const half = new SesTransport({ region: "eu-central-1", accessKeyId: "AKIA" })
		expect(half.name).toBe("ses")
	})

	test("passes upstream errors through", async () => {
		const transport = new SesTransport({ region: "eu-central-1" })
		;(transport as unknown as { client: { send(): Promise<unknown> } }).client = {
			send: () => Promise.reject(new Error("MessageRejected")),
		}
		await expect(transport.send(outgoing())).rejects.toThrow("MessageRejected")
	})
})
