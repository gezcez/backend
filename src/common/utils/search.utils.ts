// search.utils.ts
// Turkish folding for search (plan 5.2) and safe FTS5 query building.

const FOLD: Record<string, string> = {
	ı: "i",
	İ: "i",
	I: "i",
	ş: "s",
	Ş: "s",
	ğ: "g",
	Ğ: "g",
	ü: "u",
	Ü: "u",
	ö: "o",
	Ö: "o",
	ç: "c",
	Ç: "c",
	â: "a",
	Â: "a",
	î: "i",
	Î: "i",
	û: "u",
	Û: "u",
}

/** Lowercase ASCII-ish form: "Gölcük İskele" -> "golcuk iskele". */
export function foldTurkish(text: string): string {
	return text
		.replace(/[ıİIşŞğĞüÜöÖçÇâÂîÎûÛ]/g, (c) => FOLD[c] ?? c)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
}

/**
 * FTS5 MATCH expression for user input: folded tokens, each a quoted prefix query, AND-ed.
 * Returns null when nothing searchable is left.
 */
export function ftsQuery(input: string): string | null {
	const tokens = foldTurkish(input)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
		.slice(0, 8)
	if (!tokens.length) return null
	return tokens.map((token) => `"${token.replace(/"/g, "")}"*`).join(" ")
}
