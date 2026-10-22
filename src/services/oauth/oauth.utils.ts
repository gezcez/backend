// oauth.utils.ts
// Pure helpers for the authorization and token endpoints.

import { sha256Base64Url } from "@common/utils"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
export const CODE_CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/
export const PROMPT_VALUES = new Set(["none", "login", "consent", "select_account"])

/**
 * Exact, byte-for-byte match against the registered URIs. Dev clients may also use any port on
 * a registered http loopback URI (RFC 8252 section 7.3); everything else must be identical.
 */
export function matchRedirectUri(registered: string[], candidate: string, dev: boolean): boolean {
	if (registered.includes(candidate)) return true
	if (!dev) return false
	const parsed = parseLoopback(candidate)
	if (!parsed) return false
	return registered.some((uri) => {
		const other = parseLoopback(uri)
		return other !== null && other.hostname === parsed.hostname && other.rest === parsed.rest
	})
}

function parseLoopback(uri: string): { hostname: string; rest: string } | null {
	const match = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(\/[^#]*)?$/.exec(uri)
	if (!match || !LOOPBACK_HOSTS.has(match[1]!)) return null
	return { hostname: match[1]!, rest: match[3] ?? "/" }
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) without padding. */
export function pkceChallenge(verifier: string): string {
	return sha256Base64Url(verifier)
}

export function isValidVerifier(verifier: string): boolean {
	return CODE_CHALLENGE.test(verifier)
}

/** Appends query parameters to a redirect URI that may already carry a query. */
export function withQuery(uri: string, params: Record<string, string | undefined>): string {
	const url = new URL(uri)
	for (const [key, value] of Object.entries(params))
		if (value !== undefined) url.searchParams.set(key, value)
	return url.toString()
}

export function parsePrompt(value: string | undefined): string[] | null {
	if (value === undefined || value === "") return []
	const values = [...new Set(value.split(" ").filter(Boolean))]
	if (!values.every((item) => PROMPT_VALUES.has(item))) return null
	if (values.includes("none") && values.length > 1) return null
	return values
}

export function parseMaxAge(value: string | undefined): number | null | undefined {
	if (value === undefined || value === "") return undefined
	if (!/^\d{1,9}$/.test(value)) return null
	return Number(value)
}

/** Parses an HTTP Basic client authentication header (RFC 6749 section 2.3.1). */
export function parseBasicAuth(
	header: string | undefined,
): { clientId: string; secret: string } | null {
	if (!header?.startsWith("Basic ")) return null
	const decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
	const colon = decoded.indexOf(":")
	if (colon < 0) return null
	try {
		return {
			clientId: decodeURIComponent(decoded.slice(0, colon)),
			secret: decodeURIComponent(decoded.slice(colon + 1)),
		}
	} catch {
		return null
	}
}
