import { int, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { TJoinStrings } from "../util"
import { TABLE_ACTIONS } from "./users"

export type ProviderCompany = "kentkart" | "a"
export type ProviderSubdomains = {
	kentkart: {
		subdomains: "uavts" | "vts" | "uagui" | "gui"
		tlds: "com" | "com.tr"
	}
}
export type ProviderUrl<C extends ProviderCompany> = TJoinStrings<
	C extends keyof ProviderSubdomains
		? TJoinStrings<ProviderSubdomains[C]["subdomains"], ".">
		: "",
	`${C}.${"com" | "com.tr"}`
>
export const providersTable = sqliteTable("providers", {
	id: int().primaryKey({ autoIncrement: true }).unique().notNull(),
	name: text().$type<ProviderCompany>(),
	url: text().$type<ProviderUrl<ProviderCompany>>(),
	image_url: text(),
	pulled_data: text({ mode: "json" })
		.$type<
			{
				key: collected_data_key
				is_collected: boolean | string
				can_optout: boolean
				details: string
			}[]
		>()
		.default([])
		.notNull(),
	...TABLE_ACTIONS,
})

export type collected_data_key =
	| "names"
	| "national_ids"
	| "card_transactions"
	| "card_discount_types"
	| "card_images"
	| "card_basic_information"
