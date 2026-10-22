// email.repository.ts

import { Injectable } from "@nestjs/common"
import { and, eq, isNull } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import { emailSuppressionsTable, emailsTable, type EmailStatus } from "@schemas/core"

@Injectable()
export class EmailRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	insertQueued(row: {
		id: string
		user_id: number | null
		to_email: string
		template: string
		locale: string
		subject: string
	}): void {
		this.db
			.insert(emailsTable)
			.values({ ...row, status: "queued", created_at: new Date() })
			.run()
	}

	markSent(id: string, providerMessageId: string | undefined, attempts: number): void {
		this.db
			.update(emailsTable)
			.set({
				status: "sent",
				provider_message_id: providerMessageId ?? null,
				attempts,
				sent_at: new Date(),
				last_error: null,
			})
			.where(eq(emailsTable.id, id))
			.run()
	}

	markAttemptFailed(id: string, attempts: number, error: string, final: boolean): void {
		const status: EmailStatus = final ? "failed" : "queued"
		this.db
			.update(emailsTable)
			.set({ status, attempts, last_error: error.slice(0, 500) })
			.where(eq(emailsTable.id, id))
			.run()
	}

	isSuppressed(emailHash: string): boolean {
		return Boolean(
			this.db
				.select({ email_hash: emailSuppressionsTable.email_hash })
				.from(emailSuppressionsTable)
				.where(
					and(
						eq(emailSuppressionsTable.email_hash, emailHash),
						isNull(emailSuppressionsTable.removed_at),
					),
				)
				.get(),
		)
	}

	findById(id: string) {
		return this.db.select().from(emailsTable).where(eq(emailsTable.id, id)).get()
	}
}
