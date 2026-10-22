// token.service.ts
// Token endpoint (RFC 6749 authorization_code and refresh_token grants, plan section 6.1.3),
// revocation (RFC 7009) and RP-initiated logout (section 6.1.4).

import { Injectable } from "@nestjs/common"
import type { Request, Response } from "express"
import { InjectConfig, type AppConfig } from "@common/config"
import { OAuthProtocolError } from "@common/errors"
import type { AuthMethod } from "@common/jwt.types"
import { normaliseOrigin, refreshCookieOrigins } from "@common/middlewares"
import { formatScope, parseScope } from "@common/scopes"
import { newId, randomToken, safeEqual, sha256Hex } from "@common/utils"
import { AuditService } from "@services/audit/audit.service"
import type { SessionWithUser } from "@services/account/session.repository"
import { isLive, SessionService } from "@services/account/session.service"
import { ClientsService } from "./clients.service"
import { KeysService } from "./keys.service"
import type { LogoutDto, LogoutResultDto, TokenResponseDto } from "./oauth.dto"
import { OAuthRepository, type AppRow, type RefreshTokenRow } from "./oauth.repository"
import { isValidVerifier, pkceChallenge, withQuery } from "./oauth.utils"
import { RefreshGraceService } from "./refresh-grace.service"

export const REFRESH_COOKIE = "gz_rt"
export const REFRESH_COOKIE_PATH = "/v1/oauth"

type Body = Record<string, unknown>

interface Issued {
	app: AppRow
	publicId: string
	sessionId: string
	scope: string
	authTime: Date
	amr: AuthMethod[]
	refresh?: { token: string; expiresAt: Date }
}

/** One string parameter; repeated parameters are an invalid_request (RFC 6749 section 3.2). */
function param(body: Body, name: string): string | undefined {
	const value = body[name]
	if (value === undefined || value === "") return undefined
	if (typeof value !== "string" || value.length > 4096)
		throw new OAuthProtocolError("invalid_request", `${name} is malformed`)
	return value
}

function required(body: Body, name: string): string {
	const value = param(body, name)
	if (value === undefined) throw new OAuthProtocolError("invalid_request", `${name} is required`)
	return value
}

@Injectable()
export class TokenService {
	private readonly origins: Set<string>

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: OAuthRepository,
		private readonly clients: ClientsService,
		private readonly keys: KeysService,
		private readonly sessions: SessionService,
		private readonly grace: RefreshGraceService,
		private readonly audit: AuditService,
	) {
		this.origins = refreshCookieOrigins(config)
	}

	async token(req: Request, res: Response, body: Body): Promise<TokenResponseDto> {
		const cookie = this.refreshCookie(req)
		const grantType = param(body, "grant_type") ?? (cookie ? "refresh_token" : undefined)
		if (grantType === "authorization_code") return this.codeGrant(req, res, body)
		if (grantType === "refresh_token") return this.refreshGrant(req, res, body, cookie)
		if (!grantType) throw new OAuthProtocolError("invalid_request", "grant_type is required")
		throw new OAuthProtocolError("unsupported_grant_type")
	}

	private async codeGrant(req: Request, res: Response, body: Body): Promise<TokenResponseDto> {
		const app = this.clients.authenticate(req, body)
		// A browser exchange that would set gz_rt must come from that client's own origin.
		if (app.refresh_cookie && req.headers.origin !== undefined) this.checkOrigin(req, app)
		const code = required(body, "code")
		const redirectUri = required(body, "redirect_uri")
		const verifier = required(body, "code_verifier")
		const now = new Date()
		const codeHash = sha256Hex(code)
		const row = this.repository.findCode(codeHash)
		if (!row || row.client_id !== app.client_id)
			throw new OAuthProtocolError("invalid_grant", "Unknown code")

		// Single use: whatever happens below, this code is spent. A second use revokes what the
		// first one issued (RFC 6749 section 4.1.2).
		if (!this.repository.consumeCode(codeHash, now)) {
			const current = this.repository.findCode(codeHash)
			if (current?.family_id)
				this.repository.revokeFamily(current.family_id, "code_replayed", now)
			this.audit.record("auth.code_replay", {
				req,
				actorUserId: row.user_id,
				actorClientId: app.client_id,
				target: { type: "auth_request", id: row.auth_request_id },
			})
			throw new OAuthProtocolError("invalid_grant", "Code was already used")
		}
		if (row.expires_at <= now) throw new OAuthProtocolError("invalid_grant", "Code expired")
		if (row.redirect_uri !== redirectUri)
			throw new OAuthProtocolError("invalid_grant", "redirect_uri does not match")
		if (!isValidVerifier(verifier) || !safeEqual(pkceChallenge(verifier), row.code_challenge))
			throw new OAuthProtocolError("invalid_grant", "PKCE verification failed")

		const session = this.sessions.find(row.session_id)
		if (!session || !this.sessionCanHoldTokens(session, now))
			throw new OAuthProtocolError("invalid_grant", "Session has ended")

		const issued: Issued = {
			app,
			publicId: session.user.public_id,
			sessionId: row.session_id,
			scope: row.scope,
			authTime: row.auth_time,
			amr: row.amr,
		}
		if (parseScope(row.scope).includes("offline_access")) {
			const familyId = newId()
			issued.refresh = this.insertRefresh(app, {
				familyId,
				parentId: null,
				userId: row.user_id,
				sessionId: row.session_id,
				scope: row.scope,
				now,
				capAt: this.familyCap(app, session, now),
			})
			this.repository.setCodeFamily(codeHash, familyId)
		}
		this.audit.record("auth.token_issued", {
			req,
			actorUserId: row.user_id,
			actorClientId: app.client_id,
			data: { grant: "authorization_code", scope: row.scope },
		})
		return this.respond(res, issued)
	}

	private async refreshGrant(
		req: Request,
		res: Response,
		body: Body,
		cookie: string | undefined,
	): Promise<TokenResponseDto> {
		const fromBody = param(body, "refresh_token")
		const token = fromBody ?? cookie
		if (!token) throw new OAuthProtocolError("invalid_request", "refresh_token is required")
		const viaCookie = fromBody === undefined
		// The cookie path relies on Origin plus SameSite=Strict (plan section 6.1.0).
		if (viaCookie) this.checkOrigin(req)

		const now = new Date()
		const tokenHash = sha256Hex(token)
		const row = this.repository.findRefreshByHash(tokenHash)
		const app = this.clients.authenticate(req, body, viaCookie ? row?.client_id : undefined)
		if (!row || row.client_id !== app.client_id)
			throw new OAuthProtocolError("invalid_grant", "Unknown refresh token")
		if (viaCookie && !app.refresh_cookie)
			throw new OAuthProtocolError("invalid_grant", "Client does not use the refresh cookie")
		if (viaCookie) this.checkOrigin(req, app)
		if (row.revoked_at) throw new OAuthProtocolError("invalid_grant", "Refresh token revoked")

		// The family lives inside its SSO session: once the session expires (sliding or absolute)
		// or ends, so do its refresh tokens.
		const session = this.sessions.find(row.session_id)
		const user = session?.user
		if (!session || !user || !this.sessionCanHoldTokens(session, now))
			throw new OAuthProtocolError("invalid_grant", "Session has ended")

		const requested = param(body, "scope")
		const scope = requested ? parseScope(requested) : parseScope(row.scope)
		if (!scope.every((item) => parseScope(row.scope).includes(item)))
			throw new OAuthProtocolError("invalid_scope")

		const base = {
			app,
			publicId: user.public_id,
			sessionId: row.session_id,
			scope: formatScope(scope),
			authTime: session.auth_time,
			amr: session.amr,
		}

		if (row.replaced_by) {
			const successor = this.graceSuccessor(row, tokenHash)
			if (successor) return this.respond(res, { ...base, refresh: successor })
			this.repository.revokeFamily(row.family_id, "reuse_detected", now)
			this.sessions.revoke([row.session_id], "reuse_detected", false)
			this.audit.record("auth.refresh_reuse", {
				req,
				actorUserId: row.user_id,
				actorClientId: app.client_id,
				target: { type: "refresh_family", id: row.family_id },
				data: { session_id: row.session_id },
			})
			throw new OAuthProtocolError("invalid_grant", "Refresh token reuse detected")
		}
		if (row.expires_at <= now)
			throw new OAuthProtocolError("invalid_grant", "Refresh token expired")
		// The client's hard cap on a family's age, however often it rotated.
		const started = this.repository.familyStartedAt(row.family_id) ?? row.created_at
		if (now.getTime() - started.getTime() > app.refresh_max_s * 1000) {
			this.repository.revokeFamily(row.family_id, "max_age", now)
			throw new OAuthProtocolError(
				"invalid_grant",
				"Refresh token family reached its maximum age",
			)
		}

		const plaintext = randomToken()
		const successor = this.refreshRow(app, plaintext, {
			familyId: row.family_id,
			parentId: row.id,
			userId: row.user_id,
			sessionId: row.session_id,
			scope: row.scope,
			now,
			capAt: this.familyCap(app, session, started),
		})
		if (!this.repository.rotateRefresh(row.id, successor, now))
			throw new OAuthProtocolError("invalid_grant", "Refresh token was rotated concurrently")
		// Using the app keeps the SSO session alive (sliding window, never past its absolute end).
		this.sessions.keepAlive(session, now)
		this.grace.remember(tokenHash, plaintext, now.getTime())
		return this.respond(res, {
			...base,
			refresh: { token: plaintext, expiresAt: successor.expires_at },
		})
	}

	/** Same successor for a retry inside the grace window, if that successor is still the head. */
	private graceSuccessor(
		row: RefreshTokenRow,
		tokenHash: string,
	): { token: string; expiresAt: Date } | undefined {
		const plaintext = this.grace.successor(tokenHash)
		if (!plaintext || !row.replaced_at) return undefined
		if (Date.now() - row.replaced_at.getTime() > this.config.refreshGraceS * 1000)
			return undefined
		const successor = this.repository.findRefresh(row.replaced_by!)
		if (!successor || successor.revoked_at || successor.replaced_by) return undefined
		if (!safeEqual(successor.token_hash, sha256Hex(plaintext))) return undefined
		return { token: plaintext, expiresAt: successor.expires_at }
	}

	/** RFC 7009: always 200 for a well-formed request, whether or not the token was known. */
	revoke(req: Request, res: Response, body: Body): void {
		const cookie = this.refreshCookie(req)
		const fromBody = param(body, "token")
		const token = fromBody ?? cookie
		if (!token) throw new OAuthProtocolError("invalid_request", "token is required")
		const viaCookie = fromBody === undefined
		if (viaCookie) this.checkOrigin(req)
		const row = this.repository.findRefreshByHash(sha256Hex(token))
		const app = this.clients.authenticate(req, body, viaCookie ? row?.client_id : undefined)
		if (viaCookie) this.checkOrigin(req, app)
		if (row && row.client_id === app.client_id && !row.revoked_at) {
			this.repository.revokeFamily(row.family_id, "logout", new Date())
			this.audit.record("auth.logout", {
				req,
				actorUserId: row.user_id,
				actorClientId: app.client_id,
				target: { type: "refresh_family", id: row.family_id },
				data: { via: "revoke" },
			})
		}
		if (viaCookie || app.refresh_cookie) this.clearRefreshCookie(res)
	}

	/** RP-initiated logout (plan section 6.1.4, oauth.md 5.8). */
	logout(req: Request, res: Response, body: LogoutDto): LogoutResultDto {
		let redirectTo: string | undefined
		if (body.post_logout_redirect_uri !== undefined) {
			const app = this.clients.findActive(body.client_id)
			// Unknown URI: end nothing; the UI asks the user to confirm and calls again without it.
			if (!app || !app.post_logout_redirect_uris.includes(body.post_logout_redirect_uri))
				return { signed_out: false }
			redirectTo = withQuery(body.post_logout_redirect_uri, { state: body.state })
		}
		const ids =
			body.scope === "device"
				? this.sessions.liveIdsForDevice(req.device!.hash)
				: req.session
					? [req.session.id]
					: []
		const revoked = this.sessions.revoke(
			ids,
			body.scope === "device" ? "logout_device" : "logout",
			true,
		)
		this.sessions.clearCookie(res)
		if (revoked.length)
			this.audit.record("auth.logout", {
				req,
				data: { scope: body.scope, sessions: revoked.length },
			})
		return { signed_out: true, ...(redirectTo ? { redirect_to: redirectTo } : {}) }
	}

	private async respond(res: Response, issued: Issued): Promise<TokenResponseDto> {
		const ttl = issued.app.access_ttl_s
		const accessToken = await this.keys.sign(
			{
				sub: issued.publicId,
				aud: issued.app.client_id,
				scope: issued.scope,
				sid: issued.sessionId,
				auth_time: Math.floor(issued.authTime.getTime() / 1000),
				amr: issued.amr,
			},
			ttl,
		)
		res.setHeader("Cache-Control", "no-store")
		res.setHeader("Pragma", "no-cache")
		const response: TokenResponseDto = {
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: ttl,
			scope: issued.scope,
		}
		if (issued.refresh) {
			if (issued.app.refresh_cookie) this.setRefreshCookie(res, issued.refresh)
			else response.refresh_token = issued.refresh.token
		}
		return response
	}

	private insertRefresh(app: AppRow, input: RefreshInput): { token: string; expiresAt: Date } {
		const token = randomToken()
		const row = this.refreshRow(app, token, input)
		this.repository.insertRefresh(row)
		return { token, expiresAt: row.expires_at }
	}

	private refreshRow(app: AppRow, plaintext: string, input: RefreshInput): RefreshTokenRow {
		return {
			id: newId(),
			family_id: input.familyId,
			token_hash: sha256Hex(plaintext),
			parent_id: input.parentId,
			user_id: input.userId,
			client_id: app.client_id,
			session_id: input.sessionId,
			scope: input.scope,
			created_at: input.now,
			// Sliding: every rotation starts a new lifetime of the app's refresh TTL, but never past
			// the family's cap (session absolute expiry, family age limit).
			expires_at: new Date(
				Math.min(input.now.getTime() + app.refresh_ttl_s * 1000, input.capAt.getTime()),
			),
			last_used_at: null,
			replaced_by: null,
			replaced_at: null,
			revoked_at: null,
			revoke_reason: null,
		}
	}

	/** Same rule as a live cookie session: not revoked, not expired, user not banned. */
	private sessionCanHoldTokens(session: SessionWithUser, now: Date): boolean {
		return isLive(session, now)
	}

	/** A family ends at the session's absolute expiry or after the app's refresh_max_s. */
	private familyCap(app: AppRow, session: SessionWithUser, familyStart: Date): Date {
		return new Date(
			Math.min(
				session.absolute_expires_at.getTime(),
				familyStart.getTime() + app.refresh_max_s * 1000,
			),
		)
	}

	private refreshCookie(req: Request): string | undefined {
		const value = req.cookies?.[REFRESH_COOKIE] as string | undefined
		return value && value.length <= 128 ? value : undefined
	}

	/**
	 * gz_rt is spent only from a refresh cookie origin (CORS_ORIGINS minus the identity UI) and,
	 * once the client is known, only from the origin of one of its registered redirect URIs, so
	 * the dashboard's cookie works from the dashboard alone.
	 */
	private checkOrigin(req: Request, app?: AppRow): void {
		const origin = normaliseOrigin(req.headers.origin)
		if (!origin || !this.origins.has(origin))
			throw new OAuthProtocolError("invalid_request", "Origin is not allowed")
		if (app && !app.redirect_uris.some((uri) => normaliseOrigin(uri) === origin))
			throw new OAuthProtocolError("invalid_request", "Origin is not allowed for this client")
	}

	private setRefreshCookie(res: Response, refresh: { token: string; expiresAt: Date }): void {
		res.cookie(REFRESH_COOKIE, refresh.token, {
			httpOnly: true,
			secure: true,
			sameSite: "strict",
			path: REFRESH_COOKIE_PATH,
			expires: refresh.expiresAt,
		})
	}

	private clearRefreshCookie(res: Response): void {
		res.clearCookie(REFRESH_COOKIE, {
			httpOnly: true,
			secure: true,
			sameSite: "strict",
			path: REFRESH_COOKIE_PATH,
		})
	}
}

interface RefreshInput {
	familyId: string
	parentId: string | null
	userId: number
	sessionId: string
	scope: string
	now: Date
	capAt: Date
}
