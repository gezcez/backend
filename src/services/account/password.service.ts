// password.service.ts
// Optional password method (plan section 6.1.1): argon2id through Bun.password, legacy bcrypt
// hashes accepted and rehashed on login, 10 to 128 characters, a breached-password check, no
// composition rules. Wrong email, wrong password and "no password set" are one error.

import { Injectable, type OnModuleInit } from "@nestjs/common"
import type { Request, Response } from "express"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { RateLimitService } from "@common/rate-limits"
import { clientIp, normaliseEmail, verifyToken } from "@common/utils"
import { AuditService } from "@services/audit/audit.service"
import { EmailService } from "@services/email/email.service"
import { AccountRepository, type UserRow } from "./account.repository"
import { AccountService } from "./account.service"
import type { PasswordLoginDto, PasswordResetDto, PasswordSetDto, SignedInDto } from "./account.dto"
import { BreachedPasswordService } from "./breached-password.service"
import { SessionService } from "./session.service"
import { TurnstileService } from "./turnstile.service"

export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 128

@Injectable()
export class PasswordService implements OnModuleInit {
	/** Verified against when there is no user, so both paths cost the same. */
	private dummyHash = ""

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: AccountRepository,
		private readonly account: AccountService,
		private readonly sessions: SessionService,
		private readonly breached: BreachedPasswordService,
		private readonly turnstile: TurnstileService,
		private readonly limits: RateLimitService,
		private readonly email: EmailService,
		private readonly audit: AuditService,
	) {}

	async onModuleInit(): Promise<void> {
		this.dummyHash = await Bun.password.hash("not-a-real-password", { algorithm: "argon2id" })
	}

	async login(req: Request, res: Response, body: PasswordLoginDto): Promise<SignedInDto> {
		const ip = clientIp(req, this.config.trustCfHeaders)
		const email = normaliseEmail(body.email)
		// Password login fails closed when Turnstile is unreachable.
		const check = await this.turnstile.verify(body.turnstile_token, "signin", ip)
		if (!check.ok) throw new GezcezError("AUTH_TURNSTILE_FAILED")
		await this.limits.consume("password-login", { ip, email })

		const user = this.repository.findUserByEmail(email)
		const valid = await this.verify(user, body.password)
		if (!user || !valid) {
			this.audit.record("auth.login_failed", {
				req,
				actorUserId: user?.id ?? null,
				data: { method: "pwd" },
			})
			throw new GezcezError("AUTH_PASSWORD_INVALID")
		}
		return this.account.signIn(req, res, user, "pwd")
	}

	/** POST /v1/account/password/reset: new password, every session and family revoked. */
	async reset(req: Request, res: Response, body: PasswordResetDto): Promise<SignedInDto> {
		const payload = verifyToken<{ uid: number; pwu: number }>(
			this.config.secrets.codePepper,
			"reset",
			body.reset_token,
		)
		const user = payload ? this.repository.findUserById(payload.uid) : undefined
		// The token names the password it replaces, so it works once.
		if (!payload || !user || (user.password_updated_at?.getTime() ?? 0) !== payload.pwu)
			throw new GezcezError("AUTH_CODE_EXPIRED", "Reset link expired, start again")
		await this.store(user, body.new_password)
		this.sessions.revokeAllForUser(user.id, "password_reset")
		this.audit.record("auth.password_reset", {
			req,
			actorUserId: user.id,
			target: { type: "user", id: user.id },
		})
		this.notify(user)
		return this.account.signIn(req, res, this.repository.findUserById(user.id)!, "pwd")
	}

	/** POST /v1/account/reauth: refreshes auth_time and amr on the current session. */
	async reauth(req: Request, password: string): Promise<SignedInDto> {
		const session = req.session
		if (!session) throw new GezcezError("AUTH_SESSION_REQUIRED")
		const ip = clientIp(req, this.config.trustCfHeaders)
		const user = this.repository.findUserById(session.userId)!
		await this.limits.consume("password-login", { ip, email: user.email })
		if (!(await this.verify(user, password))) {
			this.audit.record("auth.login_failed", { req, data: { method: "pwd", reauth: true } })
			throw new GezcezError("AUTH_PASSWORD_INVALID")
		}
		const updated = this.sessions.reauthenticate(req, session.id, "pwd")
		this.audit.record("auth.reauth", { req, data: { method: "pwd" } })
		return {
			status: "signed_in",
			account: this.account.summary(user, true),
			auth_time: updated.authTime.toISOString(),
		}
	}

	/** PUT /v1/account/password (step-up): set or change; other sessions end unless kept. */
	async set(req: Request, body: PasswordSetDto): Promise<void> {
		const user = this.repository.findUserById(req.session!.userId)!
		await this.store(user, body.new_password)
		if (!body.keep_sessions)
			this.sessions.revokeOthers(user.id, req.session!.id, "password_reset")
		this.audit.record("auth.password_changed", {
			req,
			target: { type: "user", id: user.id },
			data: { action: user.password_hash ? "change" : "set" },
		})
		this.notify(user)
	}

	/** DELETE /v1/account/password (step-up): back to email codes only. */
	remove(req: Request): void {
		const user = this.repository.findUserById(req.session!.userId)!
		this.repository.updateUser(user.id, {
			password_hash: null,
			password_algo: null,
			password_updated_at: new Date(),
		})
		this.audit.record("auth.password_changed", {
			req,
			target: { type: "user", id: user.id },
			data: { action: "remove" },
		})
		this.notify(user)
	}

	/** Length and breach rules for a new password. */
	async assertAcceptable(password: string): Promise<void> {
		if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
			throw new GezcezError("AUTH_PASSWORD_WEAK", undefined, {
				min_length: PASSWORD_MIN,
				max_length: PASSWORD_MAX,
			})
		}
		if (await this.breached.isBreached(password))
			throw new GezcezError("AUTH_PASSWORD_BREACHED")
	}

	private async store(user: UserRow, password: string): Promise<void> {
		await this.assertAcceptable(password)
		this.repository.updateUser(user.id, {
			password_hash: await Bun.password.hash(password, { algorithm: "argon2id" }),
			password_algo: "argon2id",
			password_updated_at: new Date(),
		})
	}

	/** Constant-ish time: always runs one hash verification. Rehashes legacy bcrypt. */
	private async verify(user: UserRow | undefined, password: string): Promise<boolean> {
		if (!user?.password_hash || user.status === "deleted") {
			await Bun.password.verify(password, this.dummyHash)
			return false
		}
		let ok: boolean
		try {
			ok = await Bun.password.verify(password, user.password_hash)
		} catch {
			return false
		}
		if (ok && user.password_algo !== "argon2id") {
			this.repository.updateUser(user.id, {
				password_hash: await Bun.password.hash(password, { algorithm: "argon2id" }),
				password_algo: "argon2id",
			})
		}
		return ok
	}

	private notify(user: UserRow): void {
		this.email.send("password_changed", user.email, user.locale, {}, { userId: user.id })
	}
}
