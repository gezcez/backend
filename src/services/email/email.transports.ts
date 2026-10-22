// email.transports.ts
// ses for production and staging, console for development, memory for tests.

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2"
import { Logger } from "@nestjs/common"
import type { AppConfig } from "@common/config"
import type { RenderedEmail } from "./email.templates"

export interface OutgoingEmail extends RenderedEmail {
	id: string
	to: string
	from: string
	template: string
	/** Only the memory transport keeps these, so tests can read codes. */
	vars: Record<string, unknown>
}

export interface EmailTransport {
	readonly name: string
	send(email: OutgoingEmail): Promise<{ providerMessageId?: string }>
}

export class ConsoleTransport implements EmailTransport {
	readonly name = "console"
	private readonly logger = new Logger("Email")

	constructor(
		private readonly sink: (text: string) => void = (text) => process.stderr.write(text),
	) {}

	async send(email: OutgoingEmail) {
		// Development only (config refuses it in staging and production). The body carries codes,
		// so it goes straight to stderr and never through the shared logger, its ring buffer
		// (ops.logs) or log shipping. The logger only records that a mail was printed.
		this.sink(`\n--- email ${email.id} to ${email.to}: ${email.subject}\n${email.text}\n---\n`)
		this.logger.log(`Printed email ${email.id} (${email.template}) to stderr`)
		return {}
	}
}

export interface MailboxEntry {
	id: string
	to: string
	template: string
	subject: string
	text: string
	code?: string
	sent_at: string
}

export class MemoryTransport implements EmailTransport {
	readonly name = "memory"
	readonly messages: MailboxEntry[] = []
	/** Tests can make the next N sends fail. */
	failNext = 0

	async send(email: OutgoingEmail) {
		if (this.failNext > 0) {
			this.failNext--
			throw new Error("memory transport: simulated failure")
		}
		this.messages.push({
			id: email.id,
			to: email.to,
			template: email.template,
			subject: email.subject,
			text: email.text,
			code: typeof email.vars.code === "string" ? email.vars.code : undefined,
			sent_at: new Date().toISOString(),
		})
		if (this.messages.length > 1000) this.messages.splice(0, this.messages.length - 1000)
		return { providerMessageId: `memory-${email.id}` }
	}

	for(to: string): MailboxEntry[] {
		const address = to.toLowerCase()
		return this.messages.filter((message) => message.to === address)
	}
}

export class SesTransport implements EmailTransport {
	readonly name = "ses"
	private readonly client: SESv2Client

	constructor(config: AppConfig["email"]["ses"]) {
		this.client = new SESv2Client({
			region: config.region,
			credentials:
				config.accessKeyId && config.secretAccessKey
					? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
					: undefined,
		})
	}

	async send(email: OutgoingEmail) {
		const result = await this.client.send(
			new SendEmailCommand({
				FromEmailAddress: email.from,
				Destination: { ToAddresses: [email.to] },
				Content: {
					Simple: {
						Subject: { Data: email.subject, Charset: "UTF-8" },
						Body: {
							Text: { Data: email.text, Charset: "UTF-8" },
							Html: { Data: email.html, Charset: "UTF-8" },
						},
					},
				},
				EmailTags: [{ Name: "template", Value: email.template }],
			}),
		)
		return { providerMessageId: result.MessageId }
	}
}

export function createTransport(config: AppConfig): EmailTransport {
	switch (config.email.transport) {
		case "ses":
			return new SesTransport(config.email.ses)
		case "memory":
			return new MemoryTransport()
		default:
			return new ConsoleTransport()
	}
}
