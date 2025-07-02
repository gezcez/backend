import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rolesTable = sqliteTable("roles",{
	id: int().primaryKey({autoIncrement:true}).unique().notNull(),
	name: text().notNull().unique(),
})