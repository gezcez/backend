// account.service.ts
// Email-code flows (start, resend, verify), sign-up completion and the account bootstrap data
// for the identity UI (plan section 6.1.1, oauth plan section 4).

import { Injectable } from "@nestjs/common"
import type { Request, Response } from "express"
import type { DeviceContext, SessionContext } from "@common/auth.types"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { RateLimitService } from "@common/rate-limits"
import {
	clientIp,
	hashIp,
	hmacHex,
	initials,
	ipPrefix,
	maskEmail,
	newId,
	normaliseEmail,
	randomDigits,
	safeEqual,
	signToken,
	verifyToken,
} from "@common/utils"
import { normaliseLocale, type Locale } from "@lang"
import { AuditService } from "@services/audit/audit.service"
import { EmailService } from "@services/email/email.service"
import type { TemplateKey } from "@services/email/email.templates"
import { AccountRepository, type EmailCodeRow, type UserRow } from "./account.repository"
import type {
	AccountSummaryDto,
	DeviceAccountsDto,
	EmailChangeDto,
	EmailChangeResultDto,
	EmailFlowDto,
	EmailResendResultDto,
	EmailStartDto,
	EmailVerifyResultDto,
	SessionInfoDto,
	SignupCompleteDto,
} from "./account.dto"
import { SessionService, isLive } from "./session.service"
import { TurnstileService, type TurnstileAction } from "./turnstile.service"

export const CODE_LENGTH = 6
export const CODE_TTL_MS = 10 * 60_000
export const RESEND_AFTER_MS = 30_000
export const PROFILE_TOKEN_TTL_MS = 30 * 60_000
export const RESET_TOKEN_TTL_MS = 10 * 60_000
/** Wrong codes per address per day across all flows; then codes stop working for the day. */
export const DAILY_FAILED_CODE_CAP = 20
const DAY_MS = 86_400_000
const STAGING_TEST_DOMAIN = "@test.gezcez.com"
const MAX_DEVICE_ACCOUNTS = 5

type FlowIntent = EmailCodeRow["intent"]

interface FlowPlan {
	intent: FlowIntent
	template: TemplateKey
	userId: number | null
	/** False for flows that must never verify (reset without a password). */
	live: boolean
	locale: Locale
}

@Injectable()
export class AccountService {
	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: AccountRepository,
		private readonly sessions: SessionService,
		private readonly email: EmailService,
		private readonly turnstile: TurnstileService,
		private readonly limits: RateLimitService,
		private readonly audit: AuditService,
	) {}

	// ---------------------------------------------------------------- account data

	summary(
		user: Pick<UserRow, "public_id" | "display_name" | "email" | "locale">,
		withEmail: boolean,
	): AccountSummaryDto {
		return {
			id: user.public_id,
			display_name: user.display_name,
			email_masked: maskEmail(user.email),
			...(withEmail ? { email: user.email } : {}),
			avatar_initials: initials(user.display_name),
			locale: user.locale,
		}
	}

	sessionInfo(session: SessionContext): SessionInfoDto {
		const user = this.repository.findUserById(session.userId)
		if (!user) throw new GezcezError("AUTH_SESSION_REQUIRED")
		return {
			account: this.summary(user, true),
			session: {
				id: session.id,
				auth_time: session.authTime.toISOString(),
				amr: session.amr,
				expires_at: session.expiresAt.toISOString(),
			},
		}
	}

	/** Accounts remembered on this browser: one entry per user, newest first, at most five. */
	deviceAccounts(device: DeviceContext, current: SessionContext | undefined): DeviceAccountsDto {
		const now = new Date()
		const seen = new Set<number>()
		const accounts: DeviceAccountsDto["accounts"] = []
		for (const session of this.sessions.listByDevice(device.hash)) {
			if (session.revoke_reason === "replaced" || seen.has(session.user_id)) continue
			if (session.user.status === "deleted") continue
			seen.add(session.user_id)
			const live = isLive(session, now)
			accounts.push({
				session_id: session.id,
				account: this.summary(session.user, session.id === current?.id),
				active: session.id === current?.id,
				signed_out: !live,
			})
			if (accounts.length >= MAX_DEVICE_ACCOUNTS) break
		}
		return { accounts }
	}

	switchSession(
		req: Request,
		res: Response,
		device: DeviceContext,
		sessionId: string,
	): { account: AccountSummaryDto } {
		const session = this.sessions.switchTo(req, res, sessionId, device)
		if (!session)
			throw new GezcezError(
				"AUTH_SESSION_REQUIRED",
				"That account is not signed in on this device",
			)
		this.audit.record("auth.session_switch", {
			req,
			actorUserId: session.userId,
			target: { type: "session", id: session.id },
		})
		const user = this.repository.findUserById(session.userId)!
		return { account: this.summary(user, true) }
	}

	// ---------------------------------------------------------------- email codes

	private codeHash(flowId: string, email: string, code: string): string {
		return hmacHex(this.config.secrets.codePepper, `code:${flowId}:${email}:${code}`)
	}

	private newCode(email: string): string {
		const otp = this.config.stagingTestOtp
		return otp && email.endsWith(STAGING_TEST_DOMAIN) ? otp : randomDigits(CODE_LENGTH)
	}

	/** Decides what a flow does. Called on start and on resend, so state changes in between count. */
	private planFlow(
		intent: FlowIntent,
		email: string,
		sessionUser: UserRow | undefined,
		locale: Locale,
	): FlowPlan {
		if (intent === "reauth") {
			return {
				intent,
				template: "reauth_code",
				userId: sessionUser!.id,
				live: true,
				locale: sessionUser!.locale,
			}
		}
		const user = this.repository.findUserByEmail(email)
		const known = user && user.status !== "deleted" ? user : undefined
		if (intent === "reset") {
			return known?.password_hash
				? {
						intent,
						template: "reset_code",
						userId: known.id,
						live: true,
						locale: known.locale,
					}
				: {
						intent,
						template: "reset_unavailable",
						userId: known?.id ?? null,
						live: false,
						locale: known?.locale ?? locale,
					}
		}
		// Sign-in and sign-up share one flow: the address decides, not the button (no enumeration).
		return known
			? {
					intent: "signin",
					template: "signin_code",
					userId: known.id,
					live: true,
					locale: known.locale,
				}
			: { intent: "signup", template: "signup_code", userId: null, live: true, locale }
	}

	/** A resend keeps the flow's intent (decided at start); only reset re-checks the password. */
	private resendPlan(flow: EmailCodeRow): FlowPlan {
		const locale = flow.locale
		switch (flow.intent) {
			case "reset":
				return this.planFlow("reset", flow.email, undefined, locale)
			case "reauth":
				return {
					intent: "reauth",
					template: "reauth_code",
					userId: flow.user_id,
					live: true,
					locale,
				}
			case "signin":
				return {
					intent: "signin",
					template: "signin_code",
					userId: flow.user_id,
					live: true,
					locale,
				}
			case "change_email":
				return {
					intent: "change_email",
					template: "change_email_code",
					userId: flow.user_id,
					live: true,
					locale,
				}
			default:
				return {
					intent: flow.intent,
					template: "signup_code",
					userId: null,
					live: true,
					locale,
				}
		}
	}

	private sendCode(plan: FlowPlan, email: string, code: string): void {
		// Staging test accounts read the fixed code; nothing is delivered to that domain.
		if (this.config.stagingTestOtp && email.endsWith(STAGING_TEST_DOMAIN)) return
		const minutes = CODE_TTL_MS / 60_000
		if (plan.template === "reset_unavailable") {
			this.email.send("reset_unavailable", email, plan.locale, {}, { userId: plan.userId })
		} else {
			this.email.send(plan.template, email, plan.locale, { code, minutes } as never, {
				userId: plan.userId,
			})
		}
	}

	private async checkTurnstile(
		token: string | undefined,
		action: TurnstileAction,
		req: Request,
		email: string,
	) {
		const ip = clientIp(req, this.config.trustCfHeaders)
		const result = await this.turnstile.verify(token, action, ip)
		if (result.ok) return
		if (!result.unavailable) throw new GezcezError("AUTH_TURNSTILE_FAILED")
		// Cloudflare unreachable: keep email codes working, at half the usual limits.
		await this.limits.consume("email-code-send", { ip, email })
	}

	async startEmail(req: Request, body: EmailStartDto): Promise<EmailFlowDto> {
		let email: string
		let sessionUser: UserRow | undefined
		if (body.intent === "reauth") {
			if (!req.session) throw new GezcezError("AUTH_SESSION_REQUIRED")
			sessionUser = this.repository.findUserById(req.session.userId)
			if (!sessionUser) throw new GezcezError("AUTH_SESSION_REQUIRED")
			email = sessionUser.email
		} else {
			if (!body.email) {
				throw new GezcezError("VALIDATION_FAILED", undefined, {
					fields: [{ path: "email", message: "Required", code: "invalid_type" }],
				})
			}
			email = normaliseEmail(body.email)
		}
		await this.checkTurnstile(body.turnstile_token, body.intent, req, email)
		await this.limits.consume("email-code-send", { email }, { only: ["email"] })

		const plan = this.planFlow(body.intent, email, sessionUser, normaliseLocale(body.locale))
		const now = new Date()
		const flowId = newId("fl")
		const code = this.newCode(email)
		const expiresAt = new Date(now.getTime() + CODE_TTL_MS)
		const resendAt = new Date(now.getTime() + RESEND_AFTER_MS)
		this.repository.insertFlow({
			flow_id: flowId,
			email,
			intent: plan.intent,
			user_id: plan.userId,
			auth_request_id: body.request_id ?? null,
			locale: plan.locale,
			// A dead flow stores the hash of a code nobody knows, so every guess fails.
			code_hash: this.codeHash(flowId, email, plan.live ? code : randomDigits(32)),
			resend_available_at: resendAt,
			expires_at: expiresAt,
			ip_hash: hashIp(
				clientIp(req, this.config.trustCfHeaders),
				this.config.secrets.codePepper,
			),
			created_at: now,
		})
		this.sendCode(plan, email, code)
		this.audit.record("auth.code_sent", {
			req,
			actorUserId: plan.userId,
			target: plan.userId ? { type: "user", id: plan.userId } : undefined,
			data: { intent: plan.intent },
		})
		return {
			flow_id: flowId,
			expires_at: expiresAt.toISOString(),
			resend_available_at: resendAt.toISOString(),
			code_length: CODE_LENGTH,
		}
	}

	async resendEmail(
		req: Request,
		flowId: string,
		turnstileToken: string | undefined,
	): Promise<EmailResendResultDto> {
		const flow = this.repository.findFlow(flowId)
		const now = new Date()
		if (!flow || flow.consumed_at || flow.expires_at <= now)
			throw new GezcezError("AUTH_CODE_EXPIRED")
		if (flow.resend_available_at > now) {
			throw new GezcezError("RATE_LIMITED", "Wait before asking for another code", {
				retry_after: Math.ceil((flow.resend_available_at.getTime() - now.getTime()) / 1000),
			})
		}
		await this.checkTurnstile(turnstileToken, "resend", req, flow.email)
		await this.limits.consume("email-code-send", { email: flow.email }, { only: ["email"] })
		const plan = this.resendPlan(flow)
		const code = this.newCode(flow.email)
		const expiresAt = new Date(now.getTime() + CODE_TTL_MS)
		const resendAt = new Date(now.getTime() + RESEND_AFTER_MS)
		this.repository.resendFlow(flowId, {
			code_hash: this.codeHash(flowId, flow.email, plan.live ? code : randomDigits(32)),
			resend_available_at: resendAt,
			expires_at: expiresAt,
		})
		this.sendCode(plan, flow.email, code)
		return { resend_available_at: resendAt.toISOString(), expires_at: expiresAt.toISOString() }
	}

	async verifyEmail(
		req: Request,
		res: Response,
		flowId: string,
		code: string,
	): Promise<EmailVerifyResultDto> {
		// Email change flows are confirmed only through /email/change/verify.
		const flow = await this.consumeCode(
			req,
			flowId,
			code,
			(row) => row.intent !== "change_email",
		)

		switch (flow.intent) {
			case "reauth": {
				if (!req.session || req.session.userId !== flow.user_id)
					throw new GezcezError("AUTH_SESSION_REQUIRED")
				const session = this.sessions.reauthenticate(req, res, req.session.id, "otp")
				this.audit.record("auth.reauth", {
					req,
					actorUserId: session.userId,
					data: { method: "otp" },
				})
				const user = this.repository.findUserById(session.userId)!
				return {
					status: "signed_in",
					account: this.summary(user, true),
					auth_time: session.authTime.toISOString(),
				}
			}
			case "reset": {
				const user = flow.user_id ? this.repository.findUserById(flow.user_id) : undefined
				if (!user?.password_hash)
					throw new GezcezError("AUTH_CODE_INVALID", undefined, { attempts_left: 0 })
				const resetToken = signToken(
					this.config.secrets.codePepper,
					"reset",
					{ uid: user.id, pwu: user.password_updated_at?.getTime() ?? 0 },
					RESET_TOKEN_TTL_MS,
				)
				return { status: "reset_ready", reset_token: resetToken }
			}
			default: {
				const user = this.repository.findUserByEmail(flow.email)
				if (user && user.status !== "deleted") return this.signIn(req, res, user, "otp")
				const profileToken = signToken(
					this.config.secrets.codePepper,
					"profile",
					{ email: flow.email, flow: flow.flow_id },
					PROFILE_TOKEN_TTL_MS,
				)
				return { status: "needs_profile", profile_token: profileToken, email: flow.email }
			}
		}
	}

	async completeSignup(
		req: Request,
		res: Response,
		body: SignupCompleteDto,
	): Promise<{ account: AccountSummaryDto }> {
		const payload = verifyToken<{ email: string; flow: string }>(
			this.config.secrets.codePepper,
			"profile",
			body.profile_token,
		)
		if (!payload)
			throw new GezcezError("AUTH_CODE_EXPIRED", "Profile token expired, start again")
		if (this.repository.findUserByEmail(payload.email)) throw new GezcezError("EMAIL_TAKEN")
		const now = new Date()
		let user: UserRow
		try {
			user = this.repository.insertUser({
				public_id: newId(),
				email: payload.email,
				email_verified_at: now,
				display_name: body.display_name,
				locale: body.locale,
				terms_version: body.tos_version,
				privacy_version: body.privacy_version,
				terms_accepted_at: now,
				status: "active",
				last_login_at: now,
				created_at: now,
			})
		} catch {
			// Unique index on email: a parallel completion won.
			throw new GezcezError("EMAIL_TAKEN")
		}
		this.sessions.create(req, res, { userId: user.id, device: req.device!, amr: ["otp"] })
		this.audit.record("auth.signup", {
			req,
			actorUserId: user.id,
			target: { type: "user", id: user.id },
		})
		return { account: this.summary(user, true) }
	}

	/**
	 * Checks a code against a live flow (attempt counting, single use) and consumes it.
	 * `accept` rejects flows of the wrong kind as if they did not exist.
	 */
	private async consumeCode(
		req: Request,
		flowId: string,
		code: string,
		accept: (flow: EmailCodeRow) => boolean,
	): Promise<EmailCodeRow> {
		// A brute force spread over many IPs still shares a network range now and then; this
		// caps every code check from one /24 or /48, whatever address it targets.
		const ip = clientIp(req, this.config.trustCfHeaders)
		await this.limits.consume("email-code-verify-range", { ip: ipPrefix(ip) })
		const flow = this.repository.findFlow(flowId)
		const now = new Date()
		if (!flow || !accept(flow) || flow.consumed_at || flow.expires_at <= now)
			throw new GezcezError("AUTH_CODE_EXPIRED")
		if (flow.attempts >= flow.max_attempts) throw new GezcezError("AUTH_CODE_ATTEMPTS")
		// Per address, across resends and new flows: resending resets a flow's attempts.
		const since = new Date(now.getTime() - DAY_MS)
		if (this.repository.failedAttemptsSince(flow.email, since) >= DAILY_FAILED_CODE_CAP)
			throw new GezcezError("AUTH_CODE_ATTEMPTS")

		if (!safeEqual(this.codeHash(flow.flow_id, flow.email, code), flow.code_hash)) {
			const attempts = this.repository.incrementAttempts(flowId) ?? flow.max_attempts
			this.audit.record("auth.code_failed", {
				req,
				actorUserId: flow.user_id,
				data: { intent: flow.intent },
			})
			if (this.repository.failedAttemptsSince(flow.email, since) === DAILY_FAILED_CODE_CAP)
				this.codesLocked(req, flow)
			if (attempts >= flow.max_attempts) throw new GezcezError("AUTH_CODE_ATTEMPTS")
			throw new GezcezError("AUTH_CODE_INVALID", undefined, {
				attempts_left: flow.max_attempts - attempts,
			})
		}
		if (!this.repository.consumeFlow(flowId, now)) throw new GezcezError("AUTH_CODE_EXPIRED")
		return flow
	}

	/** The daily cap just tripped: tell the account owner (if any) and leave a trail. */
	private codesLocked(req: Request, flow: EmailCodeRow): void {
		this.audit.record("auth.codes_locked", {
			req,
			actorUserId: flow.user_id,
			target: flow.user_id ? { type: "user", id: flow.user_id } : undefined,
			data: { failed: DAILY_FAILED_CODE_CAP },
		})
		if (!flow.user_id) return
		const user = this.repository.findUserById(flow.user_id)
		if (user) this.email.send("codes_locked", user.email, user.locale, {}, { userId: user.id })
	}

	// ---------------------------------------------------------------- email change

	/** POST /v1/account/email/change (step-up): a code to the new address. */
	async startEmailChange(req: Request, body: EmailChangeDto): Promise<EmailFlowDto> {
		const user = this.repository.findUserById(req.session!.userId)!
		const email = normaliseEmail(body.new_email)
		// Bot gate and limits first: the "address taken" answer is an oracle, so it is only
		// reachable at the same rate as sending a code.
		await this.checkTurnstile(body.turnstile_token, "email_change", req, email)
		await this.limits.consume("email-change", { user: String(user.id) })
		await this.limits.consume("email-code-send", { email }, { only: ["email"] })
		if (email === user.email || this.repository.findUserByEmail(email))
			throw new GezcezError("EMAIL_TAKEN")
		const now = new Date()
		const flowId = newId("fl")
		const code = this.newCode(email)
		const expiresAt = new Date(now.getTime() + CODE_TTL_MS)
		const resendAt = new Date(now.getTime() + RESEND_AFTER_MS)
		const locale = body.locale ?? user.locale
		this.repository.insertFlow({
			flow_id: flowId,
			email,
			intent: "change_email",
			user_id: user.id,
			auth_request_id: null,
			locale,
			code_hash: this.codeHash(flowId, email, code),
			resend_available_at: resendAt,
			expires_at: expiresAt,
			ip_hash: hashIp(
				clientIp(req, this.config.trustCfHeaders),
				this.config.secrets.codePepper,
			),
			created_at: now,
		})
		this.sendCode(
			{
				intent: "change_email",
				template: "change_email_code",
				userId: user.id,
				live: true,
				locale,
			},
			email,
			code,
		)
		this.audit.record("auth.code_sent", {
			req,
			target: { type: "user", id: user.id },
			data: { intent: "change_email" },
		})
		return {
			flow_id: flowId,
			expires_at: expiresAt.toISOString(),
			resend_available_at: resendAt.toISOString(),
			code_length: CODE_LENGTH,
		}
	}

	/** POST /v1/account/email/change/verify (step-up): switches the address, notifies the old one. */
	async verifyEmailChange(
		req: Request,
		flowId: string,
		code: string,
	): Promise<EmailChangeResultDto> {
		const userId = req.session!.userId
		const flow = await this.consumeCode(
			req,
			flowId,
			code,
			(row) => row.intent === "change_email" && row.user_id === userId,
		)
		const user = this.repository.findUserById(userId)!
		const taken = this.repository.findUserByEmail(flow.email)
		if (taken && taken.id !== user.id) throw new GezcezError("EMAIL_TAKEN")
		let updated: UserRow | undefined
		try {
			updated = this.repository.updateUser(user.id, {
				email: flow.email,
				email_verified_at: new Date(),
				updated_at: new Date(),
			})
		} catch {
			throw new GezcezError("EMAIL_TAKEN")
		}
		this.email.send(
			"email_changed",
			user.email,
			user.locale,
			{
				email: maskEmail(flow.email),
				security_url: `${this.config.oauthUiUrl}/account/security`,
			},
			{ userId: user.id },
		)
		this.audit.record("auth.email_changed", {
			req,
			target: { type: "user", id: user.id },
		})
		return { email: updated!.email }
	}

	// ---------------------------------------------------------------- sign-in

	/**
	 * Proof of ownership is done (code or password): enforce bans and deletion state, then create
	 * the session. Pending-deletion accounts are signed in so they can cancel, but get the error.
	 */
	signIn(
		req: Request,
		res: Response,
		user: UserRow,
		method: "otp" | "pwd",
	): Extract<EmailVerifyResultDto, { status: "signed_in" }> {
		const now = new Date()
		this.assertNotBanned(user, now)
		if (user.status === "deleted") throw new GezcezError("USER_DELETED")
		const session = this.sessions.create(req, res, {
			userId: user.id,
			device: req.device!,
			amr: [method],
		})
		this.repository.setLastLogin(user.id, now)
		this.audit.record("auth.login", {
			req,
			actorUserId: user.id,
			target: { type: "session", id: session.id },
			data: { method },
		})
		if (user.status === "pending_deletion") {
			throw new GezcezError("USER_PENDING_DELETION", undefined, {
				delete_at: user.deletion_due_at?.toISOString(),
			})
		}
		return {
			status: "signed_in",
			account: this.summary(user, true),
			auth_time: session.authTime.toISOString(),
		}
	}

	private assertNotBanned(user: UserRow, now: Date): void {
		if (user.status !== "banned") return
		if (user.banned_until && user.banned_until <= now) {
			// Back to the lifecycle state the ban interrupted (a pending deletion survives).
			user.status = this.repository.liftExpiredBan(user.id, now)?.status ?? user.status
			if (user.status === "banned") throw new GezcezError("USER_BANNED")
			return
		}
		const ban = this.repository.latestBan(user.id)
		throw new GezcezError("USER_BANNED", undefined, {
			public_reason: ban?.public_reason ?? null,
			since: ban?.created_at.toISOString() ?? null,
			until: user.banned_until?.toISOString() ?? null,
		})
	}
}
