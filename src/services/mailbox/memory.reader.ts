// memory.reader.ts
// In-process MailboxReader for tests (MAILBOX_READER=memory, NODE_ENV=test only). deliver() is
// what a fake upstream calls when it "sends" an OTP.

import { ulid } from "ulid"
import {
	MailboxTimeoutError,
	type MailboxMessage,
	type MailboxReader,
	type WaitForMessageOptions,
} from "./mailbox.types"

interface Waiter {
	options: WaitForMessageOptions
	resolve: (message: MailboxMessage) => void
}

export class MemoryMailboxReader implements MailboxReader {
	readonly kind = "memory" as const
	private readonly messages: (MailboxMessage & { consumed: boolean })[] = []
	private readonly waiters = new Set<Waiter>()

	constructor(private readonly now: () => number = Date.now) {}

	deliver(input: Omit<MailboxMessage, "id" | "receivedAt"> & { receivedAt?: number }): void {
		const message = {
			...input,
			id: ulid(),
			to: input.to.toLowerCase(),
			receivedAt: input.receivedAt ?? Math.floor(this.now() / 1000),
			consumed: false,
		}
		for (const waiter of this.waiters) {
			if (matches(message, waiter.options)) {
				message.consumed = true
				this.waiters.delete(waiter)
				waiter.resolve(strip(message))
				return
			}
		}
		this.messages.push(message)
	}

	waitForMessage(options: WaitForMessageOptions): Promise<MailboxMessage> {
		const existing = this.messages.find((m) => !m.consumed && matches(m, options))
		if (existing) {
			existing.consumed = true
			return Promise.resolve(strip(existing))
		}
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				options,
				resolve: (message) => {
					clearTimeout(timer)
					options.signal?.removeEventListener("abort", onAbort)
					resolve(message)
				},
			}
			const done = (error: unknown) => {
				this.waiters.delete(waiter)
				clearTimeout(timer)
				options.signal?.removeEventListener("abort", onAbort)
				reject(error instanceof Error ? error : new Error(String(error)))
			}
			const onAbort = () => done(options.signal?.reason)
			const timer = setTimeout(
				() => done(new MailboxTimeoutError(options.to)),
				options.timeoutMs,
			)
			if (options.signal?.aborted) return onAbort()
			options.signal?.addEventListener("abort", onAbort, { once: true })
			this.waiters.add(waiter)
		})
	}

	/** Every message not yet consumed (assertions in tests). */
	pending(): MailboxMessage[] {
		return this.messages.filter((m) => !m.consumed).map(strip)
	}
}

function matches(message: MailboxMessage, options: WaitForMessageOptions): boolean {
	return (
		message.to === options.to.toLowerCase() &&
		message.receivedAt >= options.since &&
		(options.match?.(message) ?? true)
	)
}

function strip(message: MailboxMessage & { consumed?: boolean }): MailboxMessage {
	const { consumed: _consumed, ...rest } = message
	return rest
}
