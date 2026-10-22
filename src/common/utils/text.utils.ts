// text.utils.ts

/** e***@gmail.com: first character of the local part, then three stars. */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf("@")
	if (at <= 0) return "***"
	return `${email[0]}***${email.slice(at)}`
}

/** Up to two initials from a display name, upper-cased with Turkish rules (i -> İ). */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean)
	const letters = (words.length > 1 ? [words[0]!, words.at(-1)!] : words.slice(0, 1)).map(
		(word) => Array.from(word)[0]!,
	)
	return letters.join("").toLocaleUpperCase("tr-TR") || "?"
}

export function normaliseEmail(email: string): string {
	return email.trim().toLowerCase()
}
