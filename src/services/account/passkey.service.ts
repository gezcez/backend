// passkey.service.ts
// Passkeys (WebAuthn, plan P5, oauth.md section 5.11): registration behind step-up, list,
// rename and remove, discoverable sign-in that issues a session with amr=webauthn, and
// re-authentication of the current session. Every ceremony uses a single-use challenge row
// (`challenge_id`) bound to the device cookie, and to the user and session where one exists.

import { Injectable } from "@nestjs/common"
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server"
import type { Request, Response } from "express"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { newId } from "@common/utils"
import { AuditService } from "@services/audit/audit.service"
import { AccountRepository } from "./account.repository"
import { AccountService } from "./account.service"
import type {
	PasskeyCreationOptionsDto,
	PasskeyDto,
	PasskeyListDto,
	PasskeyRegisterDto,
	PasskeyRequestOptionsDto,
	PasskeyVerifyDto,
	SignedInDto,
} from "./account.dto"
import {
	PasskeyRepository,
	type PasskeyRow,
	type WebauthnChallengeRow,
} from "./passkey.repository"
import { requestMeta } from "./request-meta"
import { SessionService } from "./session.service"

export const CHALLENGE_TTL_MS = 5 * 60_000
export const MAX_PASSKEYS = 20

type ChallengeKind = WebauthnChallengeRow["kind"]

function b64url(value: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.from(value, "base64url"))
}

@Injectable()
export class PasskeyService {
	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: PasskeyRepository,
		private readonly accounts: AccountRepository,
		private readonly account: AccountService,
		private readonly sessions: SessionService,
		private readonly audit: AuditService,
	) {}

	// ---------------------------------------------------------------- management

	list(userId: number): PasskeyListDto {
		return { passkeys: this.repository.listForUser(userId).map((row) => this.present(row)) }
	}

	count(userId: number): number {
		return this.repository.countForUser(userId)
	}

	/** POST /v1/account/passkeys/options (step-up). */
	async registrationOptions(req: Request): Promise<PasskeyCreationOptionsDto> {
		const session = req.session!
		const user = this.accounts.findUserById(session.userId)!
		const existing = this.repository.listForUser(user.id)
		if (existing.length >= MAX_PASSKEYS)
			throw new GezcezError("CONFLICT", `At most ${MAX_PASSKEYS} passkeys per account`)
		const options = await generateRegistrationOptions({
			rpName: this.config.webauthn.rpName,
			rpID: this.config.webauthn.rpId,
			userName: user.email,
			userDisplayName: user.display_name,
			// The user handle is the public id, so a discoverable sign-in can name the account.
			userID: new TextEncoder().encode(user.public_id),
			timeout: CHALLENGE_TTL_MS,
			attestationType: "none",
			excludeCredentials: existing.map((row) => ({
				id: row.credential_id,
				transports: row.transports,
			})),
			authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
		})
		const challengeId = this.storeChallenge(req, "registration", options.challenge, {
			userId: user.id,
			sessionId: session.id,
		})
		return { challenge_id: challengeId, ...options }
	}

	/** POST /v1/account/passkeys (step-up): verifies the attestation and stores the credential. */
	async register(req: Request, body: PasskeyRegisterDto): Promise<PasskeyDto> {
		const session = req.session!
		const challenge = this.consume(req, body.challenge_id, "registration")
		if (challenge.user_id !== session.userId || challenge.session_id !== session.id)
			throw new GezcezError("AUTH_PASSKEY_INVALID", "Challenge belongs to another session")
		let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
		try {
			verification = await verifyRegistrationResponse({
				response: body.credential as RegistrationResponseJSON,
				expectedChallenge: challenge.challenge,
				expectedOrigin: this.config.webauthn.origins,
				expectedRPID: this.config.webauthn.rpId,
				requireUserVerification: false,
			})
		} catch (error) {
			throw this.invalid(error)
		}
		if (!verification.verified) throw this.invalid()
		const info = verification.registrationInfo
		if (this.repository.findByCredentialId(info.credential.id))
			throw new GezcezError("CONFLICT", "This passkey is already registered")
		const meta = requestMeta(req, this.config)
		const row = this.repository.insert({
			id: newId("pk"),
			user_id: session.userId,
			credential_id: info.credential.id,
			public_key: Buffer.from(info.credential.publicKey).toString("base64url"),
			sign_count: info.credential.counter,
			transports: info.credential.transports ?? body.credential.response.transports ?? [],
			name: body.name ?? meta.deviceLabel,
			device_hint: meta.deviceLabel,
			aaguid: info.aaguid,
			backed_up: info.credentialBackedUp,
			created_at: new Date(),
			last_used_at: null,
		})
		this.audit.record("auth.passkey_added", {
			req,
			target: { type: "passkey", id: row.id },
			data: { backed_up: row.backed_up },
		})
		return this.present(row)
	}

	/** PATCH /v1/account/passkeys/:id (step-up). */
	rename(req: Request, id: string, name: string): PasskeyDto {
		const row = this.own(req, id)
		const updated = this.repository.rename(row.id, name)!
		this.audit.record("auth.passkey_renamed", { req, target: { type: "passkey", id } })
		return this.present(updated)
	}

	/** DELETE /v1/account/passkeys/:id (step-up). Email codes stay as the recovery method. */
	remove(req: Request, id: string): void {
		const row = this.own(req, id)
		this.repository.delete(row.id)
		this.audit.record("auth.passkey_removed", { req, target: { type: "passkey", id } })
	}

	// ---------------------------------------------------------------- sign-in and re-auth

	/** POST /v1/account/passkeys/signin/options: discoverable credentials, no account named. */
	async signinOptions(req: Request, requestId?: string): Promise<PasskeyRequestOptionsDto> {
		const options = await generateAuthenticationOptions({
			rpID: this.config.webauthn.rpId,
			timeout: CHALLENGE_TTL_MS,
			userVerification: "preferred",
		})
		const challengeId = this.storeChallenge(req, "signin", options.challenge, {
			authRequestId: requestId ?? null,
		})
		return { challenge_id: challengeId, ...options }
	}

	/** POST /v1/account/passkeys/signin/verify: a new session with amr=webauthn. */
	async signinVerify(req: Request, res: Response, body: PasskeyVerifyDto): Promise<SignedInDto> {
		const challenge = this.consume(req, body.challenge_id, "signin")
		const row = await this.verifyAssertion(req, challenge, body)
		const user = this.accounts.findUserById(row.user_id)
		if (!user || user.status === "deleted") throw this.invalid()
		return this.account.signIn(req, res, user, "webauthn")
	}

	/** POST /v1/account/passkeys/reauth/options: the current user's passkeys only. */
	async reauthOptions(req: Request): Promise<PasskeyRequestOptionsDto> {
		const session = req.session!
		const passkeys = this.repository.listForUser(session.userId)
		if (passkeys.length === 0) throw new GezcezError("NOT_FOUND", "No passkeys on this account")
		const options = await generateAuthenticationOptions({
			rpID: this.config.webauthn.rpId,
			timeout: CHALLENGE_TTL_MS,
			userVerification: "preferred",
			allowCredentials: passkeys.map((row) => ({
				id: row.credential_id,
				transports: row.transports,
			})),
		})
		const challengeId = this.storeChallenge(req, "reauth", options.challenge, {
			userId: session.userId,
			sessionId: session.id,
		})
		return { challenge_id: challengeId, ...options }
	}

	/** POST /v1/account/passkeys/reauth/verify: refreshes auth_time, adds webauthn to amr. */
	async reauthVerify(req: Request, body: PasskeyVerifyDto): Promise<SignedInDto> {
		const session = req.session!
		const challenge = this.consume(req, body.challenge_id, "reauth")
		if (challenge.user_id !== session.userId || challenge.session_id !== session.id)
			throw new GezcezError("AUTH_PASSKEY_INVALID", "Challenge belongs to another session")
		const row = await this.verifyAssertion(req, challenge, body)
		if (row.user_id !== session.userId) throw this.invalid()
		const updated = this.sessions.reauthenticate(req, session.id, "webauthn")
		this.audit.record("auth.reauth", { req, data: { method: "webauthn" } })
		const user = this.accounts.findUserById(session.userId)!
		return {
			status: "signed_in",
			account: this.account.summary(user, true),
			auth_time: updated.authTime.toISOString(),
		}
	}

	// ---------------------------------------------------------------- helpers

	private async verifyAssertion(
		req: Request,
		challenge: WebauthnChallengeRow,
		body: PasskeyVerifyDto,
	): Promise<PasskeyRow> {
		const row = this.repository.findByCredentialId(body.credential.id)
		if (!row) {
			this.audit.record("auth.login_failed", { req, data: { method: "webauthn" } })
			throw this.invalid()
		}
		// The user handle, when sent, must name the credential's owner.
		const handle = body.credential.response.userHandle
		if (handle) {
			const owner = this.accounts.findUserById(row.user_id)
			if (Buffer.from(handle, "base64url").toString("utf8") !== owner?.public_id)
				throw this.invalid()
		}
		let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
		try {
			verification = await verifyAuthenticationResponse({
				response: body.credential as AuthenticationResponseJSON,
				expectedChallenge: challenge.challenge,
				expectedOrigin: this.config.webauthn.origins,
				expectedRPID: this.config.webauthn.rpId,
				credential: {
					id: row.credential_id,
					publicKey: b64url(row.public_key),
					counter: row.sign_count,
					transports: row.transports,
				},
				requireUserVerification: false,
			})
		} catch (error) {
			this.audit.record("auth.login_failed", {
				req,
				actorUserId: row.user_id,
				data: { method: "webauthn" },
			})
			throw this.invalid(error)
		}
		if (!verification.verified) throw this.invalid()
		const info = verification.authenticationInfo
		this.repository.markUsed(row.id, info.newCounter, info.credentialBackedUp, new Date())
		return row
	}

	private storeChallenge(
		req: Request,
		kind: ChallengeKind,
		challenge: string,
		bind: { userId?: number; sessionId?: string; authRequestId?: string | null },
	): string {
		const now = new Date()
		const id = newId("wc")
		this.repository.insertChallenge({
			id,
			kind,
			challenge,
			user_id: bind.userId ?? null,
			session_id: bind.sessionId ?? null,
			device_id_hash: req.device?.hash ?? null,
			auth_request_id: bind.authRequestId ?? null,
			expires_at: new Date(now.getTime() + CHALLENGE_TTL_MS),
			created_at: now,
		})
		return id
	}

	/** Single use: a challenge is spent by the first verify, whatever its outcome. */
	private consume(req: Request, id: string, kind: ChallengeKind): WebauthnChallengeRow {
		const row = this.repository.consumeChallenge(id, new Date())
		if (!row || row.kind !== kind || row.device_id_hash !== (req.device?.hash ?? null))
			throw new GezcezError("AUTH_PASSKEY_INVALID", "Challenge is unknown, used or expired")
		return row
	}

	private own(req: Request, id: string): PasskeyRow {
		const row = this.repository.findForUser(req.session!.userId, id)
		if (!row) throw new GezcezError("NOT_FOUND", "Passkey not found")
		return row
	}

	private invalid(cause?: unknown): GezcezError {
		const error = new GezcezError("AUTH_PASSKEY_INVALID")
		if (cause !== undefined) error.cause = cause
		return error
	}

	present(row: PasskeyRow): PasskeyDto {
		return {
			id: row.id,
			name: row.name,
			created_at: row.created_at.toISOString(),
			last_used_at: row.last_used_at?.toISOString() ?? null,
			device_hint: row.device_hint,
			backed_up: row.backed_up,
		}
	}
}
