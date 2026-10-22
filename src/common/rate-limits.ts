// rate-limits.ts
// Named rate-limit presets (plan section 6.15) on top of the @nestjs/throttler in-memory store.
// IP limits run in a guard (@RateLimit); per-email and per-client limits are consumed by the
// services that know the email or client after validation. Shares ThrottlerModule's store.

import { Global, Injectable, Module } from "@nestjs/common"
import { InjectThrottlerStorage, type ThrottlerStorage } from "@nestjs/throttler"
import { InjectConfig, type AppConfig } from "./config"
import { GezcezError } from "./errors"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export type RateLimitDimension = "ip" | "email" | "client"

export interface RateLimitRule {
	by: RateLimitDimension
	limit: number
	windowMs: number
}

export const RATE_LIMIT_PRESETS = {
	"email-code-send": [
		{ by: "email", limit: 5, windowMs: HOUR },
		{ by: "ip", limit: 20, windowMs: HOUR },
	],
	"email-code-verify": [{ by: "ip", limit: 30, windowMs: 10 * MINUTE }],
	"password-login": [
		{ by: "email", limit: 10, windowMs: 15 * MINUTE },
		{ by: "ip", limit: 50, windowMs: HOUR },
	],
	passkey: [{ by: "ip", limit: 60, windowMs: 10 * MINUTE }],
	token: [{ by: "ip", limit: 60, windowMs: MINUTE }],
	"public-read": [{ by: "ip", limit: 300, windowMs: MINUTE }],
	"analytics-public": [{ by: "ip", limit: 30, windowMs: MINUTE }],
	reports: [{ by: "ip", limit: 10, windowMs: HOUR }],
	telemetry: [{ by: "ip", limit: 10, windowMs: HOUR }],
	cards: [{ by: "ip", limit: 60, windowMs: HOUR }],
} as const satisfies Record<string, readonly RateLimitRule[]>

export type RateLimitPreset = keyof typeof RATE_LIMIT_PRESETS

export interface RateLimitSubject {
	ip?: string
	email?: string
	client?: string
}

@Injectable()
export class RateLimitService {
	constructor(
		@InjectConfig() private readonly config: AppConfig,
		@InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
	) {}

	/**
	 * Counts one hit for every rule of the preset whose dimension is present in `subject`.
	 * Throws RATE_LIMITED with `retry_after` (seconds) when any rule is over its limit.
	 * `factor` < 1 tightens the limits (Turnstile outage fallback halves them).
	 */
	async consume(
		preset: RateLimitPreset,
		subject: RateLimitSubject,
		options: { only?: RateLimitDimension[]; factor?: number } = {},
	): Promise<void> {
		for (const rule of RATE_LIMIT_PRESETS[preset] as readonly RateLimitRule[]) {
			if (options.only && !options.only.includes(rule.by)) continue
			const value = subject[rule.by]
			if (!value) continue
			const limit = Math.max(
				1,
				Math.floor(rule.limit * this.config.rateLimitScale * (options.factor ?? 1)),
			)
			const key = `${preset}:${rule.by}:${value.toLowerCase()}`
			const record = await this.storage.increment(
				key,
				rule.windowMs,
				limit,
				rule.windowMs,
				preset,
			)
			if (record.isBlocked) {
				throw new GezcezError("RATE_LIMITED", undefined, {
					retry_after: Math.max(1, Math.ceil(record.timeToBlockExpire)),
				})
			}
		}
	}
}

@Global()
@Module({ providers: [RateLimitService], exports: [RateLimitService] })
export class RateLimitModule {}
