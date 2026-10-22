// turnstile.service.ts
// Cloudflare Turnstile siteverify with the expected action. Without TURNSTILE_SECRET (local
// development and tests) every token passes. If Cloudflare is unreachable the caller decides:
// password login fails closed, email-code endpoints continue with halved limits.

import { Injectable, Logger } from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"

export type TurnstileAction = "signin" | "signup" | "reset" | "resend" | "email_change" | "reauth"

export type TurnstileResult = { ok: true; degraded: boolean } | { ok: false; unavailable: boolean }

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

@Injectable()
export class TurnstileService {
	private readonly logger = new Logger("Turnstile")
	/** Replaceable in tests. */
	fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
		fetch(url, init)

	constructor(@InjectConfig() private readonly config: AppConfig) {}

	get enabled(): boolean {
		return Boolean(this.config.secrets.turnstile)
	}

	async verify(
		token: string | undefined,
		action: TurnstileAction,
		ip: string,
	): Promise<TurnstileResult> {
		if (!this.enabled) return { ok: true, degraded: false }
		if (!token) return { ok: false, unavailable: false }
		try {
			const body = new URLSearchParams({
				secret: this.config.secrets.turnstile!,
				response: token,
				remoteip: ip,
			})
			const response = await this.fetchImpl(SITEVERIFY_URL, {
				method: "POST",
				body,
				signal: AbortSignal.timeout(5000),
			})
			if (!response.ok) throw new Error(`siteverify answered ${response.status}`)
			const result = (await response.json()) as { success?: boolean; action?: string }
			if (result.success === true && result.action === action)
				return { ok: true, degraded: false }
			return { ok: false, unavailable: false }
		} catch (error) {
			this.logger.warn(
				`Turnstile unavailable: ${error instanceof Error ? error.message : String(error)}`,
			)
			return { ok: false, unavailable: true }
		}
	}
}
