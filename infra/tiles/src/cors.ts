/**
 * CORS for the gezcez web apps. Native mobile requests carry no Origin and get no CORS headers.
 * Patterns come from ALLOWED_ORIGINS: exact origins, or `scheme://*.domain` for any single-level
 * subdomain (so `https://*.gezcez.com` matches dash.gezcez.com but not a.b.gezcez.com).
 */

const ALLOWED_METHODS = "GET, HEAD, OPTIONS"
const ALLOWED_HEADERS = ["range", "if-match", "if-none-match", "if-modified-since"]
const EXPOSED_HEADERS = "Accept-Ranges, Content-Length, Content-Range, ETag"

export function parseOrigins(value: string): string[] {
	return value
		.split(",")
		.map((origin) => origin.trim().replace(/\/+$/, ""))
		.filter((origin) => origin.length > 0)
}

export function isAllowedOrigin(origin: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (pattern === origin) return true
		const star = pattern.indexOf("://*.")
		if (star === -1) continue
		const scheme = pattern.slice(0, star + 3)
		const suffix = pattern.slice(star + 4)
		if (!origin.startsWith(scheme) || !origin.endsWith(suffix)) continue
		const label = origin.slice(scheme.length, origin.length - suffix.length)
		if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return true
	}
	return false
}

/** Adds CORS headers for an allowed Origin. Returns a new response with mutable headers. */
export function withCors(request: Request, response: Response, patterns: string[]): Response {
	const out = new Response(response.body, response)
	out.headers.append("Vary", "Origin")
	const origin = request.headers.get("Origin")
	if (origin && isAllowedOrigin(origin, patterns)) {
		out.headers.set("Access-Control-Allow-Origin", origin)
		out.headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS)
	}
	return out
}

export function preflight(request: Request, patterns: string[]): Response {
	const origin = request.headers.get("Origin")
	const headers = new Headers({ Vary: "Origin" })
	if (origin && isAllowedOrigin(origin, patterns)) {
		const requested = (request.headers.get("Access-Control-Request-Headers") ?? "")
			.split(",")
			.map((h) => h.trim().toLowerCase())
			.filter((h) => ALLOWED_HEADERS.includes(h))
		headers.set("Access-Control-Allow-Origin", origin)
		headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS)
		if (requested.length > 0) headers.set("Access-Control-Allow-Headers", requested.join(", "))
		headers.set("Access-Control-Max-Age", "86400")
	}
	return new Response(null, { status: 204, headers })
}
