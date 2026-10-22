// kentkart.errors.ts
// Kentkart's `result.code` catalogue (from FKart-Rewritten docs/providers/kentkart/errors.txt),
// reduced to what the backend reacts to. Unknown codes are reported as upstream errors.

export type KentkartErrorClass = "auth" | "forbidden" | "not_found" | "rate_limited" | "upstream"

export interface KentkartErrorInfo {
	message: string
	class: KentkartErrorClass
}

export const KENTKART_ERRORS: Record<number, KentkartErrorInfo> = {
	[-1]: { message: "This service is private", class: "forbidden" },
	1: { message: "Invalid region", class: "not_found" },
	2: { message: "Invalid command", class: "upstream" },
	3: { message: "Result not found", class: "not_found" },
	4: { message: "System error", class: "upstream" },
	23: { message: "Invalid card number", class: "not_found" },
	24: { message: "Card number is not registered", class: "not_found" },
	31: { message: "Daily usage limit exceeded", class: "rate_limited" },
	33: { message: "Login required (token invalid)", class: "auth" },
	37: { message: "Cannot get user info from token", class: "auth" },
	40: { message: "SOAP source error", class: "upstream" },
	48: { message: "Result not found", class: "not_found" },
	68: { message: "Maintenance in progress", class: "upstream" },
	69: { message: "Request could not be completed", class: "upstream" },
	104: { message: "Daily usage limit exceeded", class: "rate_limited" },
	113: { message: "Forbidden for this authType", class: "forbidden" },
	356: { message: "GTFS file is being prepared", class: "upstream" },
	357: { message: "GTFS file preparation started", class: "upstream" },
	408: { message: "Request timeout", class: "upstream" },
	666: { message: "System error", class: "upstream" },
	701: { message: "Timeout while connecting", class: "upstream" },
	702: { message: "Transaction unavailable", class: "upstream" },
	703: { message: "Transaction unavailable", class: "upstream" },
}

export function kentkartError(code: number): KentkartErrorInfo {
	return KENTKART_ERRORS[code] ?? { message: `Upstream error ${code}`, class: "upstream" }
}
