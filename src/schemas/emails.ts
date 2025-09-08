import { index, int, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const emailsTable = sqliteTable(
	"emails",
	{
		uuid: text().primaryKey().unique(),
		target_user_id: int().notNull(),
		target_email: text().notNull(),
		subject: text().notNull(),
		content: text().notNull(),
		type: text()
			.notNull()
			.$type<
				| "otp"
				| "activation"
				| "announcement"
				| "other"
				| "notification"
				| "system"
			>(),
		created_at: int({ mode: "timestamp_ms" }).defaultNow()
	},
	(table) => [index("emails_id_index").on(table.uuid)]
)

export const sesLogsTable = sqliteTable("ses_logs", {
	id: int().primaryKey({ autoIncrement: true }).unique().notNull(),
	email_uuid: text()
		.notNull()
		.references(() => emailsTable.uuid),

	accepted: text(),
	envelope: text(),
	messageId: text(),
	pending: text(),
	response: text(),
	rejected: text()
})
