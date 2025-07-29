import { int, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { TABLE_ACTIONS } from "@common/utils"


export const providersTable = sqliteTable("providers", {
	id: int().primaryKey({ autoIncrement: true }).unique().notNull(),
	name: text().$type(),
	url: text().$type(),
	image_url: text(),
	pulled_data: text({ mode: "json" })
		.$type<
			{
				key: string
				is_collected: boolean | string
				can_optout: boolean
				details: string
			}[]
		>()
		.default([])
		.notNull(),
	...TABLE_ACTIONS,
})
