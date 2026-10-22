export type ErrorCode =
	| "NOT_FOUND"
	| "BAD_REQUEST"
	| "METHOD_NOT_ALLOWED"
	| "PRECONDITION_FAILED"
	| "RANGE_NOT_SATISFIABLE"
	| "ARCHIVE_UNAVAILABLE"
	| "INTERNAL"

const STATUS: Record<ErrorCode, number> = {
	NOT_FOUND: 404,
	BAD_REQUEST: 400,
	METHOD_NOT_ALLOWED: 405,
	PRECONDITION_FAILED: 412,
	RANGE_NOT_SATISFIABLE: 416,
	ARCHIVE_UNAVAILABLE: 503,
	INTERNAL: 500,
}

/** Errors are short JSON bodies and never cached. */
export function errorResponse(code: ErrorCode, message: string, headers?: HeadersInit): Response {
	const out = new Headers(headers)
	out.set("Content-Type", "application/json; charset=utf-8")
	out.set("Cache-Control", "no-store")
	return new Response(JSON.stringify({ code, message }), { status: STATUS[code], headers: out })
}

export function jsonResponse(body: unknown, cacheControl: string): Response {
	return new Response(JSON.stringify(body), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": cacheControl,
		},
	})
}

export function cacheControl(maxAge: number): string {
	// Serve stale for a week while revalidating, so a rebuild never shows a blank map.
	return `public, max-age=${maxAge}, stale-while-revalidate=604800`
}

export type ByteRange = { offset: number; length: number }

/**
 * Parses a single `Range: bytes=...` header against an object of `size` bytes.
 * Returns undefined when there is no usable Range header (serve the whole object),
 * or "unsatisfiable" for a range outside the object or a multi-range request.
 */
export function parseRange(
	header: string | null,
	size: number,
): ByteRange | "unsatisfiable" | undefined {
	if (!header) return undefined
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!match) return header.trim().startsWith("bytes=") ? "unsatisfiable" : undefined
	const [, startText = "", endText = ""] = match
	if (startText === "" && endText === "") return "unsatisfiable"
	if (startText === "") {
		const suffix = Number(endText)
		if (suffix === 0 || size === 0) return "unsatisfiable"
		const length = Math.min(suffix, size)
		return { offset: size - length, length }
	}
	const start = Number(startText)
	if (start >= size) return "unsatisfiable"
	const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1)
	if (end < start) return "unsatisfiable"
	return { offset: start, length: end - start + 1 }
}

/** True when an If-None-Match header lists `etag` (or `*`). */
export function etagMatches(header: string | null, etag: string): boolean {
	if (!header) return false
	const bare = (value: string) => value.trim().replace(/^W\//, "")
	return header.split(",").some((value) => value.trim() === "*" || bare(value) === bare(etag))
}
