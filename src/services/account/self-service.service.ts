// self-service.service.ts
// Account pages (plan section 6.1.7, oauth.md section 4.4): profile, sessions, authorized apps,
// security overview and privacy toggles. Email change and passwords live in AccountService and
// PasswordService; data export and deletion arrive later.

import { Injectable } from "@nestjs/common"
import type { Request, Response } from "express"
import { GezcezError } from "@common/errors"
import { parseScope, SCOPES, isScope } from "@common/scopes"
import { AuditService, type AuditAction } from "@services/audit/audit.service"
import { AccountRepository } from "./account.repository"
import type {
	AuthorizedAppsDto,
	PrivacyDto,
	PrivacyPatchDto,
	ProfileDto,
	ProfilePatchDto,
	RevokedCountDto,
	SecurityDto,
	SessionListDto,
} from "./account.dto"
import { describeUserAgent } from "./request-meta"
import { SelfServiceRepository } from "./self-service.repository"
import { SessionService } from "./session.service"

const SECURITY_EVENTS: AuditAction[] = [
	"auth.login",
	"auth.login_failed",
	"auth.logout",
	"auth.reauth",
	"auth.signup",
	"auth.password_reset",
	"auth.password_changed",
	"auth.email_changed",
	"auth.refresh_reuse",
	"auth.session_revoked",
	"oauth.consent",
	"oauth.grant_revoked",
]
const SECURITY_EVENT_LIMIT = 20

@Injectable()
export class SelfServiceService {
	constructor(
		private readonly accounts: AccountRepository,
		private readonly repository: SelfServiceRepository,
		private readonly sessions: SessionService,
		private readonly audit: AuditService,
	) {}

	profile(userId: number): ProfileDto {
		const user = this.accounts.findUserById(userId)
		if (!user) throw new GezcezError("AUTH_SESSION_REQUIRED")
		return {
			id: user.public_id,
			display_name: user.display_name,
			email: user.email,
			email_verified_at: user.email_verified_at?.toISOString() ?? null,
			locale: user.locale,
			created_at: user.created_at.toISOString(),
			has_password: user.password_hash !== null,
			passkey_count: 0,
			...(user.status === "pending_deletion" && user.deletion_due_at
				? { deletion: { delete_at: user.deletion_due_at.toISOString() } }
				: {}),
		}
	}

	updateProfile(userId: number, body: ProfilePatchDto): ProfileDto {
		this.accounts.updateUser(userId, {
			...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
			...(body.locale !== undefined ? { locale: body.locale } : {}),
			updated_at: new Date(),
		})
		return this.profile(userId)
	}

	listSessions(req: Request): SessionListDto {
		const current = req.session!
		const live = this.sessions.listLive(current.userId)
		const refresh = this.repository.liveRefreshForUser(current.userId)
		const names = new Map(
			this.repository
				.apps([...new Set(refresh.map((row) => row.client_id))])
				.map((app) => [app.client_id, app.name]),
		)
		return {
			sessions: live
				.sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime())
				.map((session) => {
					const ua = describeUserAgent(session.user_agent ?? undefined)
					const clients = [
						...new Set(
							refresh
								.filter((row) => row.session_id === session.id)
								.map((row) => row.client_id),
						),
					]
					return {
						id: session.id,
						current: session.id === current.id,
						device: {
							label: session.device_label ?? ua.deviceLabel,
							os: ua.os,
							browser: ua.browser,
							kind: ua.kind,
						},
						...(session.approx_location
							? { approx_location: session.approx_location }
							: {}),
						created_at: session.created_at.toISOString(),
						last_seen_at: session.last_seen_at.toISOString(),
						amr: session.amr,
						apps: clients.map((client_id) => ({
							client_id,
							name: names.get(client_id) ?? client_id,
						})),
					}
				}),
		}
	}

	/** DELETE /v1/account/sessions/:id: one of the user's own sessions and its refresh families. */
	revokeSession(req: Request, res: Response, sessionId: string): void {
		const current = req.session!
		const session = this.sessions.find(sessionId)
		if (!session || session.user_id !== current.userId)
			throw new GezcezError("NOT_FOUND", "Session not found")
		const revoked = this.sessions.revoke([sessionId], "user_revoked", sessionId === current.id)
		if (sessionId === current.id) this.sessions.clearCookie(res)
		if (revoked.length)
			this.audit.record("auth.session_revoked", {
				req,
				target: { type: "session", id: sessionId },
			})
	}

	revokeOtherSessions(req: Request): RevokedCountDto {
		const current = req.session!
		const revoked = this.sessions.revokeOthers(current.userId, current.id, "user_revoked")
		this.audit.record("auth.session_revoked", { req, data: { others: revoked.length } })
		return { revoked: revoked.length }
	}

	/** Apps with a consent grant or a live refresh family. */
	authorizedApps(userId: number): AuthorizedAppsDto {
		const grants = new Map(this.repository.activeGrants(userId).map((g) => [g.client_id, g]))
		const refresh = this.repository.liveRefreshForUser(userId)
		const clientIds = [...new Set([...grants.keys(), ...refresh.map((row) => row.client_id)])]
		const apps = this.repository.apps(clientIds)
		return {
			apps: apps
				.map((app) => {
					const grant = grants.get(app.client_id)
					const tokens = refresh.filter((row) => row.client_id === app.client_id)
					const lastUsed = tokens
						.map((row) => (row.last_used_at ?? row.created_at).getTime())
						.reduce((max, value) => Math.max(max, value), 0)
					const scopes = grant ? grant.scopes : app.first_party ? app.allowed_scopes : []
					return {
						client_id: app.client_id,
						name: app.name,
						...(app.logo_url ? { logo_url: app.logo_url } : {}),
						first_party: app.first_party,
						scopes: parseScope(scopes.join(" "))
							.filter(isScope)
							.map((key) => ({ key, i18n_key: SCOPES[key].i18n_key })),
						granted_at: grant?.created_at.toISOString() ?? null,
						last_used_at: lastUsed ? new Date(lastUsed).toISOString() : null,
						active_sessions: new Set(tokens.map((row) => row.session_id)).size,
					}
				})
				.sort((a, b) => a.name.localeCompare(b.name)),
		}
	}

	revokeApp(req: Request, clientId: string): void {
		const userId = req.session!.userId
		const result = this.repository.revokeApp(userId, clientId, new Date())
		if (!result.grant && result.tokens === 0)
			throw new GezcezError("NOT_FOUND", "No access to revoke for this app")
		this.audit.record("oauth.grant_revoked", {
			req,
			target: { type: "app", id: clientId },
			data: { refresh_tokens: result.tokens },
		})
	}

	security(userId: number): SecurityDto {
		const user = this.accounts.findUserById(userId)!
		const events = this.repository.securityEvents(userId, SECURITY_EVENTS, SECURITY_EVENT_LIMIT)
		const sessionIds = events
			.filter((event) => event.target_type === "session" && event.target_id)
			.map((event) => event.target_id!)
		const sessions = new Map(
			this.repository.sessionsByIds([...new Set(sessionIds)]).map((s) => [s.id, s]),
		)
		return {
			has_password: user.password_hash !== null,
			...(user.password_updated_at && user.password_hash
				? { password_updated_at: user.password_updated_at.toISOString() }
				: {}),
			passkeys: [],
			recent_events: events.map((event) => {
				const session =
					event.target_type === "session"
						? sessions.get(event.target_id ?? "")
						: undefined
				return {
					type: event.action,
					at: event.at.toISOString(),
					...(session?.device_label ? { device_label: session.device_label } : {}),
					...(session?.approx_location
						? { approx_location: session.approx_location }
						: {}),
				}
			}),
		}
	}

	privacy(userId: number): PrivacyDto {
		const user = this.accounts.findUserById(userId)!
		return {
			location_history_opt_in: user.location_history_opt_in,
			product_emails: user.product_emails,
		}
	}

	updatePrivacy(userId: number, body: PrivacyPatchDto): PrivacyDto {
		this.accounts.updateUser(userId, {
			...(body.location_history_opt_in !== undefined
				? { location_history_opt_in: body.location_history_opt_in }
				: {}),
			...(body.product_emails !== undefined ? { product_emails: body.product_emails } : {}),
			updated_at: new Date(),
		})
		return this.privacy(userId)
	}
}
