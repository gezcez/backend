// test/helpers/browser.ts
// A tiny cookie-keeping client that behaves like the oauth UI in a browser: it sends the Origin
// of the identity UI, keeps cookies (ignoring Secure, since tests run on http), and attaches the
// CSRF token to writes.

import type { TestApp } from "./app"

export interface ApiResult<T = unknown> {
	status: number
	headers: Headers
	body: { ok: true; data: T } & {
		ok: boolean
		error: { code: string; message: string; details?: Record<string, unknown> }
	}
	data: T
	cookies: string[]
}

export class TestBrowser {
	readonly cookies = new Map<string, string>()
	csrfToken?: string
	origin: string

	constructor(
		private readonly t: TestApp,
		options: { origin?: string } = {},
	) {
		this.origin = options.origin ?? t.config.oauthUiUrl
	}

	cookieHeader(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
	}

	private store(response: Response): string[] {
		const set = response.headers.getSetCookie()
		for (const line of set) {
			const [pair, ...attributes] = line.split(";")
			const index = pair!.indexOf("=")
			const name = pair!.slice(0, index).trim()
			const value = pair!.slice(index + 1).trim()
			const expired = attributes.some((attribute) => {
				const [key, val] = attribute.trim().split("=")
				return (
					(key?.toLowerCase() === "expires" && new Date(val!).getTime() < Date.now()) ||
					(key?.toLowerCase() === "max-age" && Number(val) <= 0)
				)
			})
			if (expired || value === "") this.cookies.delete(name)
			else this.cookies.set(name, value)
		}
		return set
	}

	async request<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<ApiResult<T>> {
		const init: RequestInit = {
			method,
			headers: {
				origin: this.origin,
				...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...(method !== "GET" && this.csrfToken ? { "x-csrf-token": this.csrfToken } : {}),
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			redirect: "manual",
		}
		const response = await this.t.fetch(path, init)
		const cookies = this.store(response)
		const text = await response.text()
		const parsed = text ? JSON.parse(text) : null
		return {
			status: response.status,
			headers: response.headers,
			body: parsed,
			data: parsed?.data,
			cookies,
		}
	}

	get<T = unknown>(path: string, headers?: Record<string, string>) {
		return this.request<T>("GET", path, undefined, headers)
	}

	post<T = unknown>(path: string, body: unknown = {}, headers?: Record<string, string>) {
		return this.request<T>("POST", path, body, headers)
	}

	/** GET /v1/account/csrf, which also issues the device cookie. */
	async csrf(): Promise<string> {
		const res = await this.get<{ token: string }>("/v1/account/csrf")
		this.csrfToken = res.data.token
		return this.csrfToken
	}

	/** Latest code mailed to an address (memory transport). */
	async lastCode(email: string): Promise<string> {
		const res = await this.t.json<{ data: { messages: { code?: string }[] } }>(
			`/v1/__test/mailbox?to=${encodeURIComponent(email)}`,
		)
		const code = res.body.data.messages.at(-1)?.code
		if (!code) throw new Error(`no code mailed to ${email}`)
		return code
	}

	/** Full email-code sign-in (or sign-up when the address is new). */
	async signIn(email: string, options: { displayName?: string; requestId?: string } = {}) {
		if (!this.csrfToken) await this.csrf()
		const start = await this.post<{ flow_id: string }>("/v1/account/email/start", {
			email,
			intent: "signin",
			locale: "en",
			...(options.requestId ? { request_id: options.requestId } : {}),
		})
		if (start.status !== 202)
			throw new Error(`email/start failed: ${JSON.stringify(start.body)}`)
		const code = await this.lastCode(email)
		const verify = await this.post<{ status: string; profile_token?: string }>(
			"/v1/account/email/verify",
			{
				flow_id: start.data.flow_id,
				code,
			},
		)
		if (verify.data?.status === "needs_profile") {
			const complete = await this.post("/v1/account/signup/complete", {
				profile_token: verify.data.profile_token,
				display_name: options.displayName ?? email.split("@")[0],
				tos_version: "2026-10",
				privacy_version: "2026-10",
				locale: "en",
			})
			if (complete.status !== 200)
				throw new Error(`signup failed: ${JSON.stringify(complete.body)}`)
			return complete
		}
		if (verify.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verify.body)}`)
		return verify
	}
}
