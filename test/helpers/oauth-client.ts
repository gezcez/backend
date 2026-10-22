// test/helpers/oauth-client.ts
// The client side of an authorization code + PKCE round trip, as a client repo would run it:
// build the /authorize query, let a TestBrowser act as the oauth UI, exchange the code.

import { createHash, randomBytes } from "node:crypto"
import { decodeJwt } from "jose"
import type { TestApp } from "./app"
import { TestBrowser } from "./browser"

export const E2E_REDIRECT = "http://localhost:4710/callback"

export interface Snapshot {
	request_id: string | null
	client: { client_id: string; first_party: boolean }
	scopes: { key: string; i18n_key: string }[]
	next: "redirect" | "login" | "reauth" | "choose_account" | "consent"
	redirect_to?: string
}

export interface TokenResponse {
	access_token: string
	token_type: string
	expires_in: number
	refresh_token?: string
	scope: string
	error?: string
	error_description?: string
}

export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url")
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

export class TestOAuthClient {
	readonly pkce = pkcePair()
	readonly state = randomBytes(16).toString("base64url")

	constructor(
		private readonly t: TestApp,
		readonly clientId = "e2e_client",
		readonly redirectUri = E2E_REDIRECT,
	) {}

	params(extra: Record<string, string> = {}): Record<string, string> {
		return {
			client_id: this.clientId,
			redirect_uri: this.redirectUri,
			response_type: "code",
			scope: "openid profile email offline_access",
			state: this.state,
			code_challenge: this.pkce.challenge,
			code_challenge_method: "S256",
			...extra,
		}
	}

	async authorize(browser: TestBrowser, extra: Record<string, string> = {}) {
		if (!browser.csrfToken) await browser.csrf()
		return browser.post<Snapshot>("/v1/oauth/authorize", { params: this.params(extra) })
	}

	/** Reads code (or error) and state from a redirect_to the API returned. */
	callback(redirectTo: string): { code?: string; error?: string; state?: string; iss?: string } {
		const url = new URL(redirectTo)
		const query = Object.fromEntries(url.searchParams)
		if (`${url.origin}${url.pathname}` !== this.redirectUri)
			throw new Error(`unexpected redirect target ${redirectTo}`)
		return query
	}

	/** Runs the whole round trip for a browser that is already signed in. */
	async signInAndAuthorize(browser: TestBrowser, extra: Record<string, string> = {}) {
		const start = await this.authorize(browser, extra)
		let outcome: { next: string; redirect_to?: string } = start.data
		if (outcome.next !== "redirect" && start.data.request_id) {
			const next = await browser.post<{ next: string; redirect_to?: string }>(
				`/v1/oauth/authorize/${start.data.request_id}/continue`,
				{},
			)
			outcome = next.data
		}
		if (outcome.next !== "redirect") throw new Error(`expected redirect, got ${outcome.next}`)
		return this.callback(outcome.redirect_to!)
	}

	async token(
		body: Record<string, string>,
		options: { form?: boolean; headers?: Record<string, string> } = {},
	) {
		const form = options.form ?? true
		const response = await this.t.fetch("/v1/oauth/token", {
			method: "POST",
			headers: {
				"content-type": form ? "application/x-www-form-urlencoded" : "application/json",
				...options.headers,
			},
			body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
		})
		return {
			status: response.status,
			headers: response.headers,
			body: (await response.json()) as TokenResponse,
		}
	}

	exchange(code: string, overrides: Record<string, string> = {}) {
		return this.token({
			grant_type: "authorization_code",
			code,
			redirect_uri: this.redirectUri,
			code_verifier: this.pkce.verifier,
			client_id: this.clientId,
			...overrides,
		})
	}

	refresh(refreshToken: string, overrides: Record<string, string> = {}) {
		return this.token({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: this.clientId,
			...overrides,
		})
	}

	async revoke(token: string) {
		const response = await this.t.fetch("/v1/oauth/revoke", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token, client_id: this.clientId }).toString(),
		})
		return { status: response.status, body: await response.json() }
	}
}

export function claims(accessToken: string) {
	return decodeJwt(accessToken) as Record<string, unknown> & {
		sub: string
		aud: string
		sid: string
		scope: string
		auth_time: number
		amr: string[]
		exp: number
		iat: number
	}
}

/**
 * Signs `email` in on a fresh browser and runs the code flow; returns the access token.
 * `dashboard-dev` is the seeded client that may ask for the `dash` scope.
 */
export async function accessTokenFor(
	t: TestApp,
	email: string,
	options: { clientId?: string; scope?: string } = {},
): Promise<{ accessToken: string; browser: TestBrowser; refreshToken?: string }> {
	const clientId = options.clientId ?? "dashboard-dev"
	const redirect =
		clientId === "dashboard-dev" ? "http://localhost:5173/auth/callback" : E2E_REDIRECT
	const browser = new TestBrowser(t)
	await browser.signIn(email)
	const client = new TestOAuthClient(t, clientId, redirect)
	const { code } = await client.signInAndAuthorize(browser, {
		scope: options.scope ?? "openid profile dash",
	})
	const token = await client.exchange(code!)
	if (token.status !== 200) throw new Error(`token failed: ${JSON.stringify(token.body)}`)
	return {
		accessToken: token.body.access_token,
		browser,
		refreshToken: token.body.refresh_token,
	}
}
