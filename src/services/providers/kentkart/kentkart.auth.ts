// kentkart.auth.ts
// Refresh-token exchange per realm (plan 8.4). Credentials come only from env. The access token is
// refreshed at 80% of its lifetime or on demand after a 401 / code 33, with one request in flight
// per realm (single flight). The token is persisted through a TokenStore so restarts do not
// re-authenticate. Tokens are never logged or put into error messages.

import type { CredentialStatus } from "../transit-provider.interface"
import { ProviderError } from "../transit-provider.interface"
import type { KentkartTokenResponse } from "./kentkart.types"

export interface KentkartCredentials {
	clientId?: string
	clientSecret?: string
	refreshToken?: string
}

export interface StoredToken {
	accessToken: string
	/** Unix seconds. */
	expiresAt: number
	issuedAt: number
	refreshedAt: number
}

export interface TokenStore {
	load(realm: string): StoredToken | undefined
	save(realm: string, token: StoredToken): void
	recordFailure(realm: string, failures: number): void
}

export class MemoryTokenStore implements TokenStore {
	private readonly tokens = new Map<string, StoredToken>()
	load(realm: string) {
		return this.tokens.get(realm)
	}
	save(realm: string, token: StoredToken) {
		this.tokens.set(realm, token)
	}
	recordFailure() {}
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface KentkartAuthOptions {
	realm: string
	authUrl: string
	region: string
	authType: string
	credentials: KentkartCredentials
	store: TokenStore
	fetchFn: FetchFn
	userAgent: string
	now?: () => number
	/** Seconds between attempts once the refresh token was rejected. */
	authFailedRetryS?: number
	timeoutMs?: number
}

const DEFAULT_LIFETIME_S = 3600
const REFRESH_AT = 0.8

/** Reads `exp` and `iat` from a JWT payload without verifying it (we only schedule refreshes). */
export function decodeJwtTimes(token: string): { exp?: number; iat?: number } {
	const part = token.split(".")[1]
	if (!part) return {}
	try {
		const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
			exp?: unknown
			iat?: unknown
			nbf?: unknown
		}
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
		return { exp: num(json.exp), iat: num(json.iat) ?? num(json.nbf) }
	} catch {
		return {}
	}
}

export class KentkartAuth {
	private token: StoredToken | undefined
	private loaded = false
	private inflight: Promise<string> | undefined
	private failures = 0
	private authFailedAt: number | undefined
	private refreshing = false
	private readonly now: () => number

	constructor(private readonly options: KentkartAuthOptions) {
		this.now = options.now ?? Date.now
	}

	get realm(): string {
		return this.options.realm
	}

	private nowS(): number {
		return Math.floor(this.now() / 1000)
	}

	private hasCredentials(): boolean {
		const c = this.options.credentials
		return Boolean(c.clientId && c.clientSecret && c.refreshToken)
	}

	private refreshDue(token: StoredToken): boolean {
		const lifetime = Math.max(60, token.expiresAt - token.issuedAt)
		return this.nowS() >= token.issuedAt + lifetime * REFRESH_AT
	}

	/** A valid access token, refreshing first when due. */
	async getToken(): Promise<string> {
		if (!this.loaded) {
			this.loaded = true
			this.token = this.options.store.load(this.options.realm)
		}
		if (this.token && !this.refreshDue(this.token)) return this.token.accessToken
		// A token that is due but not yet expired is still usable if the refresh fails.
		try {
			return await this.refresh()
		} catch (error) {
			if (this.token && this.nowS() < this.token.expiresAt - 30) return this.token.accessToken
			throw error
		}
	}

	/** Refreshes now (single flight). Used after a 401 / code 33 and by "refresh token". */
	refresh(): Promise<string> {
		if (!this.inflight) {
			this.inflight = this.exchange().finally(() => {
				this.inflight = undefined
			})
		}
		return this.inflight
	}

	private async exchange(): Promise<string> {
		if (!this.hasCredentials()) {
			throw new ProviderError(
				"auth_failed",
				"Kentkart credentials are not configured (KENTKART_CLIENT_ID, KENTKART_CLIENT_SECRET, KENTKART_REFRESH_TOKEN)",
			)
		}
		const retryS = this.options.authFailedRetryS ?? 900
		if (this.authFailedAt !== undefined && this.nowS() - this.authFailedAt < retryS) {
			throw new ProviderError(
				"auth_failed",
				"Kentkart refresh token was rejected; set a new KENTKART_REFRESH_TOKEN",
			)
		}
		this.refreshing = true
		const { credentials, authUrl, region, authType } = this.options
		const url = `${authUrl.replace(/\/$/, "")}/oauth/token?${new URLSearchParams({ region, authType })}`
		let response: Response
		try {
			response = await this.options.fetchFn(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"User-Agent": this.options.userAgent,
				},
				body: JSON.stringify({
					clientId: credentials.clientId,
					clientSecret: credentials.clientSecret,
					redirectUri: "m.kentkart.com",
					refreshToken: credentials.refreshToken,
					grantType: "refreshToken",
				}),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
			})
		} catch (error) {
			this.fail()
			const timeout = (error as Error).name === "TimeoutError"
			throw new ProviderError(
				timeout ? "timeout" : "upstream_error",
				`Kentkart token request failed: ${timeout ? "timeout" : "network error"}`,
			)
		} finally {
			this.refreshing = false
		}
		let body: KentkartTokenResponse = {}
		try {
			body = (await response.json()) as KentkartTokenResponse
		} catch {
			// handled below
		}
		if (response.status >= 500) {
			this.fail()
			throw new ProviderError(
				"upstream_error",
				`Kentkart token endpoint answered ${response.status}`,
				{
					httpStatus: response.status,
				},
			)
		}
		if (!response.ok || !body.accessToken) {
			this.fail()
			this.authFailedAt = this.nowS()
			throw new ProviderError(
				"auth_failed",
				`Kentkart rejected the refresh token (HTTP ${response.status}${body.result?.code !== undefined ? `, code ${String(body.result.code)}` : ""})`,
				{ httpStatus: response.status },
			)
		}
		const now = this.nowS()
		const times = decodeJwtTimes(body.accessToken)
		const expiresIn = Number(body.expiresIn)
		const issuedAt = times.iat && times.iat <= now + 60 ? times.iat : now
		const expiresAt =
			times.exp ??
			(Number.isFinite(expiresIn) && expiresIn > 0
				? now + expiresIn
				: now + DEFAULT_LIFETIME_S)
		this.token = { accessToken: body.accessToken, expiresAt, issuedAt, refreshedAt: now }
		this.failures = 0
		this.authFailedAt = undefined
		this.options.store.save(this.options.realm, this.token)
		return body.accessToken
	}

	private fail(): void {
		this.failures++
		this.options.store.recordFailure(this.options.realm, this.failures)
	}

	status(): CredentialStatus {
		const c = this.options.credentials
		const state: CredentialStatus["state"] = !this.hasCredentials()
			? "missing"
			: this.refreshing
				? "refreshing"
				: this.authFailedAt !== undefined
					? "auth_failed"
					: this.token
						? "ok"
						: "unknown"
		return {
			realm: this.options.realm,
			state,
			expiresAt: this.token?.expiresAt ?? null,
			refreshedAt: this.token?.refreshedAt ?? null,
			failures: this.failures,
			secretsSet: {
				KENTKART_CLIENT_ID: Boolean(c.clientId),
				KENTKART_CLIENT_SECRET: Boolean(c.clientSecret),
				KENTKART_REFRESH_TOKEN: Boolean(c.refreshToken),
			},
		}
	}
}
