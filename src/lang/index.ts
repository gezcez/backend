// lang
// Server-rendered text only (emails). API errors are codes that clients translate.

import { en, type LangKey } from "./en"
import { tr } from "./tr"

export type { LangKey }
export type Locale = "tr" | "en"
export const LOCALES: Locale[] = ["tr", "en"]

const catalogs: Record<Locale, Record<LangKey, string>> = { tr, en }

export function normaliseLocale(value: string | undefined | null): Locale {
	const short = (value ?? "").toLowerCase().split(/[-_ ]/)[0]
	return short === "en" ? "en" : "tr"
}

/** t("tr", "email.code_valid", { minutes: 10 }) */
export function t(
	locale: Locale,
	key: LangKey,
	args: Record<string, string | number> = {},
): string {
	const template = catalogs[locale][key] ?? catalogs.en[key]
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in args ? String(args[name]) : match,
	)
}
