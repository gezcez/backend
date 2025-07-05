import { int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { TABLE_ACTIONS } from "./users";
import { providersTable } from "./providers";

export const networksTable = sqliteTable("networks",{
	id:int().primaryKey({autoIncrement:true}).notNull(),
	name:text().unique().notNull(),
	country:text().notNull(),
	provider_id: int().references(()=>providersTable.id),
	network_id_defined_by_provider: text(),
	network_public_secret: text(),
	hide: int({mode:"boolean"}).default(true),
	...TABLE_ACTIONS

})