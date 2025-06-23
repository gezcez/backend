import { int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { TABLE_ACTIONS } from "./users";

export const networksTable = sqliteTable("networks",{
	id:int().primaryKey({autoIncrement:true}),
	name:text().unique().notNull(),
	country:text().notNull(),
	...TABLE_ACTIONS

})