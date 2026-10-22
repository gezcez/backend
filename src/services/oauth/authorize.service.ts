// authorize.service.ts
// Server-side authorization requests (plan section 6.1.2, oauth.md sections 3.3 and 5).
// The UI posts the raw /authorize query; this service validates it, stores an `ar_` row bound to
// the device and decides what the UI shows next. Codes are issued only from here.

import { Injectable } from "@nestjs/common"
import type { Request, Response } from "express"
import type { SessionContext } from "@common/auth.types"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { formatScope, isScope, parseScope } from "@common/scopes"
import { newId, normaliseEmail, randomToken, sha256Hex } from "@common/utils"
import { AuditService } from "@services/audit/audit.service"
import { isLive, SessionService } from "@services/account/session.service"
import { ClientsService, scopeInfo } from "./clients.service"
import type { AuthorizeNextDto, AuthorizeSnapshotDto, NextStep } from "./oauth.dto"
import { OAuthRepository, type AppRow, type AuthRequestRow } from "./oauth.repository"
import {
	CODE_CHALLENGE,
	matchRedirectUri,
	parseMaxAge,
	parsePrompt,
	withQuery,
} from "./oauth.utils"

export const AUTH_REQUEST_TTL_MS = 10 * 60_000
export const AUTH_CODE_TTL_MS = 60_000

type RedirectError =
	| "invalid_request"
	| "invalid_scope"
	| "access_denied"
	| "login_required"
	| "consent_required"
	| "account_selection_required"

interface Outcome {
	next: NextStep
	redirect_to?: string
}

@Injectable()
export class AuthorizeService {
	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: OAuthRepository,
		private readonly clients: ClientsService,
		private readonly sessions: SessionService,
		private readonly audit: AuditService,
	) {}

	/** POST /v1/oauth/authorize: validate in the order of plan 6.1.2, store, decide. */
	start(req: Request, params: Record<string, string>): AuthorizeSnapshotDto {
		const app = this.clients.findActive(params.client_id)
		if (!app) throw new GezcezError("OAUTH_INVALID_CLIENT")
		const redirectUri = params.redirect_uri
		if (!redirectUri || !matchRedirectUri(app.redirect_uris, redirectUri, app.dev))
			throw new GezcezError("OAUTH_INVALID_REDIRECT_URI")

		// From here on errors go back to the client.
		const state = params.state
		const reject = (error: RedirectError, description: string): AuthorizeSnapshotDto => ({
			request_id: null,
			client: this.clients.info(app),
			scopes: [],
			next: "redirect",
			redirect_to: this.errorRedirect(redirectUri, error, description, state),
		})
		if (params.response_type !== "code")
			return reject("invalid_request", "response_type must be code")
		if (params.code_challenge_method !== "S256")
			return reject("invalid_request", "code_challenge_method must be S256")
		if (!params.code_challenge || !CODE_CHALLENGE.test(params.code_challenge))
			return reject("invalid_request", "code_challenge must be 43 to 128 characters")
		if (!state || state.length > 512) return reject("invalid_request", "state is required")
		const scopes = parseScope(params.scope)
		if (scopes.length === 0) return reject("invalid_scope", "scope is required")
		if (!scopes.every((scope) => isScope(scope) && app.allowed_scopes.includes(scope)))
			return reject("invalid_scope", "scope is not allowed for this client")
		const prompt = parsePrompt(params.prompt)
		if (prompt === null) return reject("invalid_request", "prompt is malformed")
		const maxAge = parseMaxAge(params.max_age)
		if (maxAge === null) return reject("invalid_request", "max_age is malformed")

		const now = new Date()
		const request: AuthRequestRow = {
			id: newId("ar"),
			client_id: app.client_id,
			redirect_uri: redirectUri,
			scope: formatScope(scopes),
			state,
			code_challenge: params.code_challenge,
			prompt: prompt.length ? prompt.join(" ") : null,
			max_age: maxAge ?? null,
			login_hint: params.login_hint?.slice(0, 254) || null,
			ui_locales: params.ui_locales?.slice(0, 64) || null,
			device_id_hash: req.device!.hash,
			session_id: null,
			status: "pending",
			created_at: now,
			expires_at: new Date(now.getTime() + AUTH_REQUEST_TTL_MS),
		}
		this.repository.insertRequest(request)
		return this.snapshot(request, app, this.decide(req, request, app))
	}

	/** GET /v1/oauth/authorize/:requestId: same snapshot, `next` recomputed. */
	get(req: Request, requestId: string): AuthorizeSnapshotDto {
		const { request, app } = this.load(req, requestId)
		return this.snapshot(request, app, this.decide(req, request, app))
	}

	/** After sign-in or account choice: binds the chosen session to the request. */
	continue(req: Request, res: Response, requestId: string, sessionId?: string): AuthorizeNextDto {
		const { request, app } = this.load(req, requestId)
		let session = req.session
		if (sessionId && sessionId !== session?.id) {
			session = this.sessions.switchTo(req, res, sessionId, req.device!) ?? undefined
			if (!session) throw new GezcezError("AUTH_SESSION_REQUIRED")
			this.audit.record("auth.session_switch", {
				req,
				target: { type: "session", id: session.id },
			})
		}
		if (!session) throw new GezcezError("AUTH_SESSION_REQUIRED")
		this.repository.updateRequest(request.id, { session_id: session.id })
		request.session_id = session.id
		return this.decide(req, request, app)
	}

	/** Consent screen answer (third-party clients only). */
	decision(req: Request, requestId: string, decision: "approve" | "deny"): AuthorizeNextDto {
		const { request, app } = this.load(req, requestId)
		const session = req.session
		if (!session) throw new GezcezError("AUTH_SESSION_REQUIRED")
		if (decision === "deny") {
			this.audit.record("oauth.consent", {
				req,
				target: { type: "app", id: app.client_id },
				data: { decision },
			})
			return this.fail(request, "access_denied", "The user denied the request")
		}
		const grant = this.repository.findGrant(session.userId, app.client_id)
		const previous = grant && !grant.revoked_at ? grant.scopes : []
		const scopes = [...new Set([...previous, ...parseScope(request.scope)])]
		this.repository.upsertGrant(session.userId, app.client_id, scopes, new Date())
		this.audit.record("oauth.consent", {
			req,
			target: { type: "app", id: app.client_id },
			data: { decision, scopes },
		})
		// Consent counts as choosing the signed-in account for this request.
		if (!request.session_id) {
			this.repository.updateRequest(request.id, { session_id: session.id })
			request.session_id = session.id
		}
		return this.decide(req, request, app)
	}

	private load(req: Request, requestId: string): { request: AuthRequestRow; app: AppRow } {
		const request = this.repository.findRequest(requestId)
		if (!request || request.device_id_hash !== req.device?.hash)
			throw new GezcezError("OAUTH_REQUEST_NOT_FOUND")
		if (request.status !== "pending" || request.expires_at <= new Date())
			throw new GezcezError("OAUTH_REQUEST_EXPIRED")
		const app = this.clients.findActive(request.client_id)
		if (!app) throw new GezcezError("OAUTH_INVALID_CLIENT")
		return { request, app }
	}

	/**
	 * What happens next, from the request and the current session (oauth.md 5.6 and 5.7).
	 * With prompt=none every interaction becomes an error redirect instead.
	 */
	private decide(req: Request, request: AuthRequestRow, app: AppRow): Outcome {
		const prompt = parsePrompt(request.prompt ?? undefined) ?? []
		const interaction = (next: NextStep, error: RedirectError): Outcome =>
			prompt.includes("none")
				? this.fail(request, error, "User interaction is required")
				: { next }

		const session = req.session
		if (!session) return interaction("login", "login_required")

		const authenticatedSinceRequest = session.authTime >= request.created_at
		if (prompt.includes("login") && !authenticatedSinceRequest)
			return interaction("reauth", "login_required")

		if (request.session_id !== session.id) {
			if (prompt.includes("select_account"))
				return interaction("choose_account", "account_selection_required")
			const hint = request.login_hint ? normaliseEmail(request.login_hint) : undefined
			const email = this.sessions.find(session.id)?.user.email
			if (hint ? hint !== email : this.liveSessionsOnDevice(req) > 1)
				return interaction("choose_account", "account_selection_required")
		}

		if (
			request.max_age !== null &&
			Date.now() - session.authTime.getTime() > request.max_age * 1000
		)
			return interaction("reauth", "login_required")

		if (!app.first_party && !this.consented(session, request, prompt))
			return interaction("consent", "consent_required")

		return this.issueCode(request, session)
	}

	private consented(session: SessionContext, request: AuthRequestRow, prompt: string[]): boolean {
		const grant = this.repository.findGrant(session.userId, request.client_id)
		if (!grant || grant.revoked_at) return false
		if (!parseScope(request.scope).every((scope) => grant.scopes.includes(scope))) return false
		return !prompt.includes("consent") || grant.updated_at >= request.created_at
	}

	private liveSessionsOnDevice(req: Request): number {
		const now = new Date()
		const users = new Set<number>()
		for (const session of this.sessions.listByDevice(req.device!.hash))
			if (isLive(session, now)) users.add(session.user_id)
		return users.size
	}

	private issueCode(request: AuthRequestRow, session: SessionContext): Outcome {
		if (!this.repository.finishRequest(request.id, "completed"))
			throw new GezcezError("OAUTH_REQUEST_EXPIRED")
		const code = randomToken()
		const now = new Date()
		this.repository.insertCode({
			code_hash: sha256Hex(code),
			client_id: request.client_id,
			user_id: session.userId,
			session_id: session.id,
			auth_request_id: request.id,
			redirect_uri: request.redirect_uri,
			scope: request.scope,
			code_challenge: request.code_challenge,
			auth_time: session.authTime,
			amr: session.amr,
			created_at: now,
			expires_at: new Date(now.getTime() + AUTH_CODE_TTL_MS),
			consumed_at: null,
			family_id: null,
		})
		return {
			next: "redirect",
			redirect_to: withQuery(request.redirect_uri, {
				code,
				state: request.state,
				iss: this.config.issuer,
			}),
		}
	}

	private fail(request: AuthRequestRow, error: RedirectError, description: string): Outcome {
		if (!this.repository.finishRequest(request.id, "denied"))
			throw new GezcezError("OAUTH_REQUEST_EXPIRED")
		return {
			next: "redirect",
			redirect_to: this.errorRedirect(
				request.redirect_uri,
				error,
				description,
				request.state,
			),
		}
	}

	private errorRedirect(
		redirectUri: string,
		error: RedirectError,
		description: string,
		state: string | undefined,
	): string {
		return withQuery(redirectUri, {
			error,
			error_description: description,
			state: state && state.length <= 512 ? state : undefined,
			iss: this.config.issuer,
		})
	}

	private snapshot(request: AuthRequestRow, app: AppRow, outcome: Outcome): AuthorizeSnapshotDto {
		return {
			request_id: request.id,
			client: this.clients.info(app),
			scopes: scopeInfo(parseScope(request.scope)),
			...(request.prompt ? { prompt: request.prompt } : {}),
			...(request.login_hint ? { login_hint: request.login_hint } : {}),
			...(request.ui_locales ? { ui_locales: request.ui_locales } : {}),
			...outcome,
		}
	}
}
