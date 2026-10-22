// mailbox.types.ts
// Inbound mail contract for provider OTPs (KENTKART_AUTO_AUTH). A MailboxReader waits for the next
// message to an address this backend controls. Readers: memory (tests), imap, webhook (Cloudflare
// Email Worker posting to /v1/internal/inbound-email), smtp (built-in receiver). Bodies and codes
// are never logged.

export interface MailboxMessage {
	id: string
	/** Lower-cased envelope recipient. */
	to: string
	from: string
	subject: string
	/** Plain text (HTML converted to text by the reader), at most 64 KiB. */
	text: string
	/** Unix seconds. */
	receivedAt: number
}

export interface WaitForMessageOptions {
	/** Recipient address, compared case-insensitively. */
	to: string
	/** Only messages received at or after this unix second. */
	since: number
	timeoutMs: number
	/** Extra filter, e.g. sender domain or subject. */
	match?: (message: MailboxMessage) => boolean
	signal?: AbortSignal
}

export interface MailboxReader {
	readonly kind: "memory" | "imap" | "webhook" | "smtp"
	/**
	 * Resolves with the first matching message and marks it consumed so it is never returned twice.
	 * Rejects with MailboxTimeoutError after timeoutMs, or with the signal's reason when aborted.
	 */
	waitForMessage(options: WaitForMessageOptions): Promise<MailboxMessage>
	close?(): Promise<void>
}

export class MailboxTimeoutError extends Error {
	constructor(readonly to: string) {
		super("No matching email arrived in time")
		this.name = "MailboxTimeoutError"
	}
}

/** Nest injection token for the configured reader (absent when MAILBOX_READER=none). */
export const MAILBOX_READER = Symbol("MAILBOX_READER")

export const MAX_BODY_BYTES = 64 * 1024
