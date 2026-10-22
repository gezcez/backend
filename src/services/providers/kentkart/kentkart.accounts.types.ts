// kentkart.accounts.types.ts
// Contract for automatic Kentkart accounts (KENTKART_AUTO_AUTH). The realtime GTFS-RT feed needs
// an authenticated passenger (authType 4) token, so the tracker provisions its own account per
// realm: register by email OTP, log in, keep the refresh token, and log in again or register a new
// account when Kentkart stops accepting it. Credentials are sealed in vts.db provider_accounts and
// never logged. With auto auth off, KENTKART_REFRESH_TOKEN is the only credential (plan 8.4).
//
// Known upstream shapes (FKart-Rewritten, kentkart-vts-observer):
//   POST {auth}/oauth/authorize?region&authType=4&lang=tr
//        {clientId, countryCode:"tr", loginType:"email", responseType:"code", email, pin}
//        -> {result:{code:0}, code}
//   POST {auth}/oauth/token {clientId, clientSecret, redirectUri:"m.kentkart.com",
//        grantType:"authorizationCode", code} -> {result:{code:0}, accessToken, refreshToken}
//   POST {auth}/oauth/token {..., grantType:"refreshToken", refreshToken} -> {accessToken, ...}
//   POST {auth}/oauth/otp?region&authType  (send an email OTP; body shape unverified)
// Registration's exact path and body are unverified. Every path can be overridden with
// KENTKART_AUTH_PATHS until a capture confirms them.

/** Endpoint keys for KENTKART_AUTH_PATHS overrides. */
export type KentkartAuthPathKey = "otp" | "otpVerify" | "register" | "authorize" | "token"

export interface KentkartTokenSet {
	accessToken: string
	/** Kentkart may or may not rotate it; absent means keep the current one. */
	refreshToken?: string
	/** Unix seconds. */
	issuedAt: number
	expiresAt: number
}

export interface KentkartRealmParams {
	authUrl: string
	region: string
	authType: string
}

/** Why an auth call failed, mapped from HTTP status and result.code. Never carries secrets. */
export type KentkartAuthFailure =
	| "otp_invalid"
	| "otp_expired"
	| "account_not_found"
	| "account_exists"
	| "credentials_rejected"
	| "refresh_rejected"
	| "rate_limited"
	| "upstream_error"
	| "timeout"
	| "unexpected_response"

export class KentkartAuthError extends Error {
	constructor(
		readonly failure: KentkartAuthFailure,
		message: string,
		readonly details: { httpStatus?: number; resultCode?: number | string } = {},
	) {
		super(message)
		this.name = "KentkartAuthError"
	}
}

export interface KentkartProfile {
	name: string
	surname: string
	/** Six digit Kentkart PIN used as the password. */
	pin: string
}

/** Stateless HTTP client for the Kentkart auth service (kentkart.auth-api.ts). */
export interface KentkartAuthApi {
	/** Asks Kentkart to email a one-time code. */
	requestOtp(realm: KentkartRealmParams, email: string): Promise<void>
	/**
	 * Verifies an emailed code. Returns an authorization code when the email already has an
	 * account, or needsRegistration (with whatever token the register call needs) when it does not.
	 */
	verifyOtp(
		realm: KentkartRealmParams,
		email: string,
		otp: string,
	): Promise<{ code: string } | { needsRegistration: true; registrationToken?: string }>
	/** Creates the account; returns an authorization code when Kentkart logs it in directly. */
	register(
		realm: KentkartRealmParams,
		input: { email: string; otp: string; registrationToken?: string; profile: KentkartProfile },
	): Promise<{ code?: string }>
	/** Email + PIN login. */
	login(realm: KentkartRealmParams, email: string, pin: string): Promise<{ code: string }>
	exchangeCode(realm: KentkartRealmParams, code: string): Promise<KentkartTokenSet>
	refresh(realm: KentkartRealmParams, refreshToken: string): Promise<KentkartTokenSet>
}

export type KentkartAccountState =
	"provisioning" | "active" | "refresh_failed" | "login_failed" | "disabled" | "retired"

/** Public view of an account (admin API, dashboard). No secrets. */
export interface KentkartAccountView {
	id: number
	realm: string
	email: string
	state: KentkartAccountState
	origin: "env" | "auto"
	createdAt: number
	registeredAt: number | null
	lastLoginAt: number | null
	lastRefreshAt: number | null
	failures: number
	lastError: string | null
}

/**
 * What KentkartAuth asks for when it needs a refresh token (kentkart.accounts.ts). Implemented by
 * KentkartAccountManager; KentkartAuth falls back to the env refresh token when none is given.
 */
export interface KentkartCredentialSource {
	/** A refresh token for the realm, provisioning or logging in first when needed. */
	refreshTokenFor(realm: string, params: KentkartRealmParams): Promise<string>
	/** Kentkart rotated the refresh token. */
	rotated(realm: string, refreshToken: string): void
	/** Kentkart rejected the refresh token: log in again, else register a new account. */
	rejected(realm: string, reason: string): void
}

/** Admin operations (tracker admin API). */
export interface KentkartAccountsAdmin {
	list(realm?: string): KentkartAccountView[]
	/** Retires the active account of the realm and provisions a fresh one (counts toward budget). */
	reprovision(realm: string): Promise<KentkartAccountView>
	/** Forces a password login for the active account. */
	relogin(realm: string): Promise<KentkartAccountView>
	disable(id: number): KentkartAccountView
}

export const KENTKART_ACCOUNTS = Symbol("KENTKART_ACCOUNTS")
