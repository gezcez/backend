// email_codes.ts
// One row per email-code flow (sign-in, sign-up, re-auth, reset, email change).

import { index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export type EmailCodeIntent = "signin" | "signup" | "reauth" | "reset" | "change_email"

export const emailCodesTable = sqliteTable(
	"email_codes",
	{
		id: int().primaryKey({ autoIncrement: true }),
		/** `fl_` + ULID, handed to the UI. */
		flow_id: text().notNull(),
		email: text().notNull(),
		intent: text().$type<EmailCodeIntent>().notNull(),
		/** The user the code proves, when the address belongs to one at start time. */
		user_id: int(),
		auth_request_id: text(),
		/** Language of the emails sent for this flow (resends reuse it). */
		locale: text().$type<"tr" | "en">().notNull().default("tr"),
		code_hash: text().notNull(),
		attempts: int().notNull().default(0),
		max_attempts: int().notNull().default(5),
		/** Codes sent for this flow (first send plus resends), for the per-email limit. */
		sends: int().notNull().default(1),
		resend_available_at: int({ mode: "timestamp_ms" }).notNull(),
		expires_at: int({ mode: "timestamp_ms" }).notNull(),
		consumed_at: int({ mode: "timestamp_ms" }),
		ip_hash: text(),
		created_at: int({ mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("email_codes_flow_id_unique").on(t.flow_id),
		index("email_codes_email_intent_idx").on(t.email, t.intent, t.created_at),
		index("email_codes_ip_idx").on(t.ip_hash, t.created_at),
	],
)

export type EmailCodeRow = typeof emailCodesTable.$inferSelect
