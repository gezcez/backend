import { index, int, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { usersTable } from "./users";

export const emailsTable = sqliteTable("emails",{
	uuid:text().primaryKey().unique(),
	target_user_id:int(),
	content:text().notNull(),
	type:text().notNull().$type<"otp"|"activation"|"announcement"|"other">(),
	created_at:int({mode:"timestamp_ms"}).defaultNow(),
},(table)=>[
	index("emails_id_index").on(table.uuid)
])