// otp.ts
// Pulls a one-time code out of a provider email. Implemented by the IMAP track; the contract is:
// return the code (4 to 8 digits) the message asks the reader to enter, or undefined.

import type { MailboxMessage } from "./mailbox.types"

export function extractOtp(message: Pick<MailboxMessage, "subject" | "text">): string | undefined {
	// Placeholder until the IMAP track lands Kentkart fixtures: the first standalone 4-8 digit run.
	const match = /(?<!\d)(\d{4,8})(?!\d)/.exec(`${message.subject}\n${message.text}`)
	return match?.[1]
}
