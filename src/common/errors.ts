// errors.ts
// The single list of API error codes (plan section 3.3). Clients translate by `code`; `message`
// is English developer text. The list is published as the `ErrorCode` enum in openapi.json.

export const ERROR_CODES = {
	VALIDATION_FAILED: { status: 400, message: "Request validation failed" },
	AUTH_REQUIRED: { status: 401, message: "Authentication required" },
	AUTH_SESSION_REQUIRED: { status: 401, message: "A signed-in session is required" },
	AUTH_TOKEN_INVALID: { status: 401, message: "Access token is invalid" },
	AUTH_TOKEN_EXPIRED: { status: 401, message: "Access token has expired" },
	AUTH_SESSION_REVOKED: { status: 401, message: "Session has been revoked" },
	AUTH_CODE_INVALID: { status: 400, message: "Code is invalid" },
	AUTH_CODE_EXPIRED: { status: 400, message: "Code has expired" },
	AUTH_CODE_ATTEMPTS: { status: 429, message: "Too many attempts for this code" },
	AUTH_PASSWORD_INVALID: { status: 401, message: "Email or password is invalid" },
	AUTH_PASSWORD_WEAK: { status: 400, message: "Password does not meet the requirements" },
	AUTH_PASSWORD_BREACHED: { status: 400, message: "Password appears in a known breach" },
	AUTH_TURNSTILE_FAILED: { status: 400, message: "Bot check failed" },
	AUTH_STEP_UP_REQUIRED: { status: 403, message: "Recent authentication required" },
	CSRF_INVALID: { status: 403, message: "CSRF check failed" },
	OAUTH_INVALID_CLIENT: { status: 400, message: "Unknown or disabled client" },
	OAUTH_INVALID_REDIRECT_URI: { status: 400, message: "redirect_uri is not registered" },
	OAUTH_REQUEST_EXPIRED: { status: 410, message: "Authorization request has expired" },
	OAUTH_REQUEST_NOT_FOUND: { status: 404, message: "Authorization request not found" },
	SCOPE_MISSING: { status: 403, message: "Token lacks the required scope" },
	PERMISSION_MISSING: { status: 403, message: "Permission missing" },
	ROLE_LEVEL_TOO_LOW: { status: 403, message: "Your role level is too low for this change" },
	ROLE_IMMUTABLE: { status: 403, message: "This role cannot be changed" },
	USER_BANNED: { status: 403, message: "Account is banned" },
	USER_PENDING_DELETION: { status: 403, message: "Account is scheduled for deletion" },
	USER_DELETED: { status: 410, message: "Account has been deleted" },
	EMAIL_TAKEN: { status: 409, message: "Email is already in use" },
	USERNAME_TAKEN: { status: 409, message: "Username is already in use" },
	NOT_FOUND: { status: 404, message: "Not found" },
	CONFLICT: { status: 409, message: "Conflict" },
	VERSION_CONFLICT: { status: 412, message: "Resource version does not match" },
	RATE_LIMITED: { status: 429, message: "Too many requests" },
	PROVIDER_DISABLED: { status: 503, message: "Provider is disabled" },
	PROVIDER_UNAVAILABLE: { status: 502, message: "Provider is unavailable" },
	CAPABILITY_UNSUPPORTED: { status: 404, message: "Capability not supported here" },
	CARD_NOT_FOUND: { status: 404, message: "Card not found" },
	ANALYTICS_TIMEOUT: { status: 504, message: "Analytics query timed out" },
	INTERNAL: { status: 500, message: "Internal server error" },
} as const satisfies Record<string, { status: number; message: string }>

export type ErrorCode = keyof typeof ERROR_CODES
export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[]

export type ErrorDetails = Record<string, unknown>

/** Throw this from services and repositories. The exception filter turns it into the envelope. */
export class GezcezError extends Error {
	readonly code: ErrorCode
	readonly status: number
	readonly details?: ErrorDetails

	constructor(code: ErrorCode, message?: string, details?: ErrorDetails) {
		super(message ?? ERROR_CODES[code].message)
		this.name = "GezcezError"
		this.code = code
		this.status = ERROR_CODES[code].status
		this.details = details
	}
}

export function isErrorCode(value: unknown): value is ErrorCode {
	return typeof value === "string" && value in ERROR_CODES
}

/**
 * RFC 6749 section 5.2 error for the protocol endpoints (`/v1/oauth/token`, `/v1/oauth/revoke`).
 * Rendered as `{ error, error_description }` without the envelope so stock OAuth clients parse it.
 */
export type OAuthErrorCode =
	| "invalid_request"
	| "invalid_client"
	| "invalid_grant"
	| "unauthorized_client"
	| "unsupported_grant_type"
	| "invalid_scope"
	| "slow_down"
	| "server_error"

export class OAuthProtocolError extends Error {
	constructor(
		readonly error: OAuthErrorCode,
		readonly description?: string,
		readonly status = error === "invalid_client" ? 401 : error === "server_error" ? 500 : 400,
	) {
		super(description ?? error)
		this.name = "OAuthProtocolError"
	}
}
