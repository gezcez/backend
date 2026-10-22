// dash-users.service.ts
// Dashboard user search and detail (emails always masked), audited email reveal, and admin
// session management: SSO sessions and refresh families, revoke one or all (plan 6.3).

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { hasPermission } from "@common/authorization"
import { GezcezError } from "@common/errors"
import type { Page } from "@common/response"
import { maskEmail } from "@common/utils"
import type { UserRow } from "@schemas/core"
import { describeUserAgent } from "@services/account/request-meta"
import { SessionService } from "@services/account/session.service"
import { AuditService } from "@services/audit/audit.service"
import { RefsService } from "@services/refs/refs.service"
import { PermissionCacheService } from "@services/roles/permission-cache.service"
import type { Ban, DashUser, DashUserQueryDto, DashUserStatus, UserSession } from "./dash-users.dto"
import { DashUsersRepository, type UserListRow } from "./dash-users.repository"

type ListItem = Page<{
	id: string
	display_name: string
	username: string | null
	email_masked: string
	status: DashUserStatus
	created_at: string
	last_active_at: string | null
	role_count: number
}>

export function dashStatus(
	user: Pick<UserRow, "status" | "banned_until" | "email_verified_at" | "deletion_due_at">,
	now = new Date(),
): DashUserStatus {
	switch (user.status) {
		case "banned":
			// An expired ban is lifted on the user's next sign-in; show it as lifted already. A
			// lifted ban returns to the lifecycle state it interrupted (finding 4).
			if (!user.banned_until || user.banned_until > now) return "banned"
			return user.deletion_due_at ? "pending_deletion" : "active"
		case "pending_deletion":
			return "pending_deletion"
		default:
			return user.email_verified_at ? "active" : "unverified"
	}
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null)

@Injectable()
export class DashUsersService {
	constructor(
		private readonly repository: DashUsersRepository,
		private readonly refs: RefsService,
		private readonly sessions: SessionService,
		private readonly permissions: PermissionCacheService,
		private readonly audit: AuditService,
	) {}

	list(req: Request, query: DashUserQueryDto): ListItem {
		const page = this.repository.page(
			{
				q: query.q,
				emailSearch: this.canReadPii(req),
				status: query.status,
				roleKey: query.role,
				networkId: query.network_id,
				from: query.from ? new Date(query.from) : undefined,
				to: query.to ? new Date(query.to) : undefined,
			},
			query,
		)
		return { ...page, items: page.items.map((row) => this.listItem(row)) }
	}

	listItem(row: UserListRow) {
		return {
			id: row.public_id,
			display_name: row.display_name,
			username: row.username,
			email_masked: maskEmail(row.email),
			status: dashStatus(row),
			created_at: row.created_at.toISOString(),
			last_active_at: iso(row.last_active_ms),
			role_count: row.role_count,
		}
	}

	detail(publicId: string): DashUser {
		const user = this.find(publicId)
		const assignments = this.repository.assignments(user.id)
		const ban = user.status === "banned" ? this.repository.latestBan(user.id) : undefined
		const users = this.refs.users([
			...assignments.map((a) => a.granted_by),
			ban?.created_by ?? null,
		])
		const networks = this.refs.networks(assignments.map((a) => a.network_id))
		const status = dashStatus(user)
		return {
			id: user.public_id,
			display_name: user.display_name,
			username: user.username,
			email_masked: maskEmail(user.email),
			status,
			locale: user.locale,
			created_at: user.created_at.toISOString(),
			last_active_at: iso(user.last_active_ms),
			email_verified: user.email_verified_at !== null,
			methods: { email_code: true, password: user.password_hash !== null, passkeys: 0 },
			roles: assignments.map((a) => ({
				network: a.network_id === null ? null : (networks.get(a.network_id) ?? null),
				role: { id: a.role_id, key: a.role_key, name: a.role_name, level: a.role_level },
				granted_at: a.granted_at.toISOString(),
				granted_by: a.granted_by === null ? null : (users.get(a.granted_by) ?? null),
			})),
			ban:
				status === "banned" && ban
					? {
							public_reason: ban.public_reason ?? "",
							private_reason: ban.private_reason,
							until: user.banned_until?.toISOString() ?? null,
							created_at: ban.created_at.toISOString(),
							created_by:
								ban.created_by === null
									? null
									: (users.get(ban.created_by) ?? null),
						}
					: null,
		} satisfies DashUser & { ban: Ban | null }
	}

	revealEmail(req: Request, publicId: string): { email: string } {
		const user = this.find(publicId)
		this.audit.record("users.email_revealed", {
			req,
			target: { type: "user", id: user.id },
		})
		return { email: user.email }
	}

	listSessions(publicId: string): UserSession[] {
		const user = this.find(publicId)
		const now = new Date()
		const sessions = this.repository.liveSessions(user.id, now)
		const heads = this.repository.liveFamilyHeads(user.id, now)
		const starts = this.repository.familyStarts(heads.map((head) => head.family_id))
		const appNames = this.refs.appNames(heads.map((head) => head.client_id))
		const familySessions = new Map(
			this.repository
				.sessionsByIds([...new Set(heads.map((head) => head.session_id))])
				.map((session) => [session.id, session]),
		)
		const device = (session?: { device_label: string | null; user_agent: string | null }) =>
			session
				? (session.device_label ??
					describeUserAgent(session.user_agent ?? undefined).deviceLabel)
				: "Unknown device"
		return [
			...sessions.map((session) => ({
				id: `sso_${session.id}`,
				kind: "sso" as const,
				app: null,
				device: device(session),
				ip_prefix: session.ip_prefix,
				created_at: session.created_at.toISOString(),
				last_used_at: session.last_seen_at.toISOString(),
				expires_at: (session.expires_at < session.absolute_expires_at
					? session.expires_at
					: session.absolute_expires_at
				).toISOString(),
			})),
			...heads.map((head) => {
				const session = familySessions.get(head.session_id)
				return {
					id: `rf_${head.family_id}`,
					kind: "refresh" as const,
					app: {
						client_id: head.client_id,
						name: appNames.get(head.client_id) ?? head.client_id,
					},
					device: device(session),
					ip_prefix: session?.ip_prefix ?? null,
					created_at: (starts.get(head.family_id) ?? head.created_at).toISOString(),
					last_used_at: (head.last_used_at ?? head.created_at).toISOString(),
					expires_at: head.expires_at.toISOString(),
				}
			}),
		]
	}

	/** Revokes one SSO session (with the refresh families issued under it) or one family. */
	revokeSession(req: Request, publicId: string, id: string, reason: string): { revoked: number } {
		const user = this.find(publicId)
		let revoked = 0
		if (id.startsWith("sso_")) {
			const session = this.repository.findLiveSession(user.id, id.slice(4))
			if (!session) throw new GezcezError("NOT_FOUND", "Session not found")
			const families = this.repository.liveFamiliesOfSession(session.id)
			revoked =
				this.sessions.revoke([session.id], "admin_revoked", false).length + families.length
		} else if (id.startsWith("rf_")) {
			revoked = this.repository.revokeFamilies(user.id, new Date(), [id.slice(3)]).length
			if (revoked === 0) throw new GezcezError("NOT_FOUND", "Session not found")
		} else {
			throw new GezcezError("NOT_FOUND", "Session not found")
		}
		this.audit.record("users.session_revoked", {
			req,
			target: { type: "user", id: user.id },
			data: { session: id, reason },
		})
		return { revoked }
	}

	/** Signs the user out everywhere: every SSO session and every refresh family. */
	revokeAll(req: Request, publicId: string, reason: string): { revoked: number } {
		const user = this.find(publicId)
		const sessions = this.sessions.revokeAllForUser(user.id, "admin_revoked")
		const families = this.repository.revokeFamilies(user.id, new Date())
		this.audit.record("users.sessions_revoked", {
			req,
			target: { type: "user", id: user.id },
			data: { reason, sessions: sessions.length, families: families.length },
		})
		return { revoked: sessions.length + families.length }
	}

	/** Users to add as network members: username or name prefix; exact email with users.pii.read. */
	candidates(req: Request, q: string) {
		return this.repository.searchCandidates(q, this.canReadPii(req), 20).map((row) => ({
			id: row.public_id,
			display_name: row.display_name,
			username: row.username,
		}))
	}

	find(publicId: string) {
		const user = this.repository.findByPublicId(publicId)
		if (!user) throw new GezcezError("NOT_FOUND", "User not found")
		return user
	}

	private canReadPii(req: Request): boolean {
		return req.auth
			? hasPermission(this.permissions.forUser(req.auth.userId), "users.pii.read")
			: false
	}
}
