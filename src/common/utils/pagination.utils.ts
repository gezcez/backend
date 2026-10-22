// pagination.utils.ts
// Opaque cursors for the list contract (plan 7.0). A cursor binds an offset to the filters it
// was issued for, so changing any filter or sort invalidates it.

import { GezcezError } from "../errors"
import { sha256Base64Url } from "./crypto.utils"

interface CursorPayload {
	o: number
	f: string
}

function fingerprint(filters: unknown): string {
	return sha256Base64Url(JSON.stringify(filters ?? null)).slice(0, 12)
}

export function encodeCursor(offset: number, filters: unknown): string {
	const payload: CursorPayload = { o: offset, f: fingerprint(filters) }
	return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

/** Offset encoded in `cursor`; 0 without a cursor. Throws VALIDATION_FAILED on a stale cursor. */
export function decodeCursor(cursor: string | undefined, filters: unknown): number {
	if (!cursor) return 0
	try {
		const payload = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		) as CursorPayload
		if (
			typeof payload.o !== "number" ||
			payload.o < 0 ||
			!Number.isInteger(payload.o) ||
			payload.f !== fingerprint(filters)
		)
			throw new Error("stale")
		return payload.o
	} catch {
		throw new GezcezError("VALIDATION_FAILED", "Invalid or stale cursor", {
			fields: { cursor: "invalid" },
		})
	}
}

/** Builds a Page<T> from `limit + 1` fetched rows at `offset`. */
export function pageFrom<T>(
	rows: T[],
	offset: number,
	limit: number,
	filters: unknown,
	total: number | null,
): { items: T[]; next_cursor: string | null; prev_cursor: string | null; total: number | null } {
	const hasMore = rows.length > limit
	return {
		items: hasMore ? rows.slice(0, limit) : rows,
		next_cursor: hasMore ? encodeCursor(offset + limit, filters) : null,
		prev_cursor: offset > 0 ? encodeCursor(Math.max(0, offset - limit), filters) : null,
		total,
	}
}
