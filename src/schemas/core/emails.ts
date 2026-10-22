// emails.ts
// Email outbox metadata. Bodies, codes and links are never stored.

import { index, int, sqliteTable, text } from "drizzle-orm/sqlite-core"

export type EmailStatus = "queued" | "sent" | "delivered" | "bounced" | "complained" | "failed"

export const emailsTable = sqliteTable(
	"emails",
	{
		/** ULID */
		id: text().primaryKey(),
		user_id: int(),
		to_email: text().notNull(),
		template: text().notNull(),
		locale: text().notNull(),
		subject: text().notNull(),
		status: text().$type<EmailStatus>().notNull().default("queued"),
		provider_message_id: text(),
		attempts: int().notNull().default(0),
		last_error: text(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
		sent_at: int({ mode: "timestamp_ms" }),
		/** Last status change (send, bounce, complaint). */
		updated_at: int({ mode: "timestamp_ms" }),
	},
	(t) => [
		index("emails_status_idx").on(t.status, t.created_at),
		index("emails_user_idx").on(t.user_id, t.created_at),
	],
)

export const emailSuppressionsTable = sqliteTable("email_suppressions", {
	email_hash: text().primaryKey(),
	reason: text().$type<"bounce" | "complaint" | "manual">().notNull(),
	/** Masked address for the dashboard; the address itself is never stored. */
	email_masked: text(),
	detail: text(),
	created_at: int({ mode: "timestamp_ms" }).notNull(),
	removed_at: int({ mode: "timestamp_ms" }),
	removed_by: int(),
	removed_reason: text(),
})

export type EmailRow = typeof emailsTable.$inferSelect
export type EmailSuppressionRow = typeof emailSuppressionsTable.$inferSelect
