import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { config } from "../util";
export const usersTable = sqliteTable("users", {
	id: int().primaryKey({"autoIncrement":true}),
	username: text({ length: config.validation.username.max_length }).notNull().unique(),
	email: text({ length: 255 }).notNull().unique(),
	password: text({ length: 255 }).notNull(),

	created_at: int({mode:"timestamp"}).defaultNow(),
	updated_at: int({mode:"timestamp"}).defaultNow(),
	is_activated: int({mode:"boolean"}).default(false)


});