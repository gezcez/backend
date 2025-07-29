import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { IConfig } from "@types";
import { buildConfig } from "@common/utils";
const config = buildConfig()
export const usersTable = sqliteTable("users", {
	id: int().primaryKey({"autoIncrement":true}),
	username: text({ length: config.validation.username.max_length }).notNull().unique(),
	email: text({ length: 255 }).notNull().unique(),
	password: text({ length: 255 }).notNull(),

	created_at: int({mode:"timestamp_ms"}).defaultNow(),
	updated_at: int({mode:"timestamp_ms"}),
	activated_at: int({mode:"timestamp_ms"}),
	ban_record: int(),
});

