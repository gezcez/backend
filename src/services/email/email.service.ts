// email.service.ts
// Outbox: every send gets an `emails` row (metadata only). Bodies, codes and links live only in
// memory while sending; failed sends retry with exponential backoff up to 5 attempts.

import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"
import { newId, sha256Hex } from "@common/utils"
import type { Locale } from "@lang"
import { EmailRepository } from "./email.repository"
import { renderTemplate, type TemplateKey, type TemplateVars } from "./email.templates"
import { createTransport, type EmailTransport, type OutgoingEmail } from "./email.transports"

export const MAX_EMAIL_ATTEMPTS = 5
const BASE_RETRY_MS = 30_000

export interface SendOptions {
	userId?: number | null
	/** Dashboard test sends mark the subject, for example "[TEST] ". */
	subjectPrefix?: string
}

@Injectable()
export class EmailService implements OnApplicationShutdown {
	private readonly logger = new Logger("Email")
	readonly transport: EmailTransport
	private readonly timers = new Set<ReturnType<typeof setTimeout>>()
	/** Overridable in tests. */
	retryDelayMs = (attempt: number) => BASE_RETRY_MS * 2 ** (attempt - 1)

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: EmailRepository,
	) {
		this.transport = createTransport(config)
	}

	/**
	 * Queues and starts sending. Resolves once the first attempt finished, but callers on
	 * enumeration-sensitive paths must not await it (timing would leak whether an account exists).
	 */
	send<K extends TemplateKey>(
		template: K,
		to: string,
		locale: Locale,
		vars: TemplateVars[K],
		options: SendOptions = {},
	): { id: string; done: Promise<void> } {
		const address = to.toLowerCase()
		const prefix = options.subjectPrefix ?? ""
		const body = renderTemplate(template, locale, vars)
		const rendered = { ...body, subject: prefix + body.subject }
		const id = newId()
		this.repository.insertQueued({
			id,
			user_id: options.userId ?? null,
			to_email: address,
			template,
			locale,
			// Codes never reach the database, not even inside the subject line.
			subject:
				"code" in (vars as object)
					? prefix + renderTemplate(template, locale, { ...vars, code: "******" }).subject
					: rendered.subject,
		})
		if (this.repository.isSuppressed(sha256Hex(address))) {
			this.repository.markAttemptFailed(id, 0, "suppressed", true)
			return { id, done: Promise.resolve() }
		}
		const email: OutgoingEmail = {
			...rendered,
			id,
			to: address,
			from: this.config.email.from,
			template,
			vars: vars as Record<string, unknown>,
		}
		return { id, done: this.attempt(email, 1) }
	}

	private async attempt(email: OutgoingEmail, attempt: number): Promise<void> {
		try {
			const result = await this.transport.send(email)
			this.repository.markSent(email.id, result.providerMessageId, attempt)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const final = attempt >= MAX_EMAIL_ATTEMPTS
			this.repository.markAttemptFailed(email.id, attempt, message, final)
			this.logger.warn(
				`Email ${email.id} (${email.template}) attempt ${attempt} failed: ${message}`,
			)
			if (!final) {
				const timer = setTimeout(() => {
					this.timers.delete(timer)
					void this.attempt(email, attempt + 1)
				}, this.retryDelayMs(attempt))
				timer.unref?.()
				this.timers.add(timer)
			}
		}
	}

	onApplicationShutdown(): void {
		for (const timer of this.timers) clearTimeout(timer)
		this.timers.clear()
	}
}
