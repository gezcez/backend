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
	type: text().$type<ProviderCompany>(),
	url: text().$type<ProviderUrl<ProviderCompany>>(),
	image_url: text(),
	overrides: text({mode:"json"}).$type<{}>(),
	...TABLE_ACTIONS
})
