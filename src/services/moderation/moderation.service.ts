// moderation.service.ts
// Ban and unban (plan 6.14). A ban sets users.status, ends every SSO session and refresh family
// at once (access tokens of those sessions stop working on the next request), and writes
// moderation_actions and audit rows. Moderators cannot ban themselves or anyone whose role level
// is not below theirs.

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { actOnUserError, effectiveLevel, highestLevel } from "@common/authorization"
import { GezcezError } from "@common/errors"
import type { Page } from "@common/response"
import { SessionService } from "@services/account/session.service"
import { AuditService } from "@services/audit/audit.service"
import { RefsService } from "@services/refs/refs.service"
import { PermissionCacheService } from "@services/roles/permission-cache.service"
import type { Ban } from "@services/users/dash-users.dto"
import { DashUsersRepository } from "@services/users/dash-users.repository"
import { dashStatus, DashUsersService } from "@services/users/dash-users.service"
import {
	BAN_DURATIONS,
	type BanRequestDto,
	type ModerationAction,
	type ModerationQueryDto,
} from "./moderation.dto"
import { ModerationRepository } from "./moderation.repository"

const DAY_MS = 86_400_000

@Injectable()
export class ModerationService {
	constructor(
		private readonly repository: ModerationRepository,
		private readonly users: DashUsersService,
		private readonly usersRepository: DashUsersRepository,
		private readonly sessions: SessionService,
		private readonly permissions: PermissionCacheService,
		private readonly refs: RefsService,
		private readonly audit: AuditService,
	) {}

	ban(req: Request, publicId: string, body: BanRequestDto): Ban {
		const executorId = req.auth!.userId
		const user = this.users.find(publicId)
		this.assertCanModerate(executorId, user.id)
		const now = new Date()
		const days = BAN_DURATIONS[body.duration]
		const until = days === null ? null : new Date(now.getTime() + days * DAY_MS)
		const action = this.repository.ban({
			userId: user.id,
			by: executorId,
			publicReason: body.public_reason,
			privateReason: body.private_reason ?? null,
			until,
			now,
		})
		const sessions = this.sessions.revokeAllForUser(user.id, "ban")
		const families = this.usersRepository.revokeFamilies(user.id, now)
		this.audit.record("moderation.ban", {
			req,
			target: { type: "user", id: user.id },
			data: {
				before: { status: dashStatus(user) },
				after: {
					status: "banned",
					duration: body.duration,
					public_reason: body.public_reason,
					sessions_revoked: sessions.length,
					families_revoked: families.length,
				},
			},
		})
		return {
			public_reason: body.public_reason,
			private_reason: action.private_reason,
			until: until?.toISOString() ?? null,
			created_at: now.toISOString(),
			created_by: this.refs.users([executorId]).get(executorId) ?? null,
		}
	}

	unban(req: Request, publicId: string, reason: string): { unbanned: boolean } {
		const executorId = req.auth!.userId
		const user = this.users.find(publicId)
		if (dashStatus(user) !== "banned")
			throw new GezcezError("CONFLICT", "The user is not banned")
		this.assertCanModerate(executorId, user.id)
		this.assertCanLift(executorId, this.usersRepository.latestBan(user.id)?.created_by)
		this.repository.unban({ userId: user.id, by: executorId, reason, now: new Date() })
		const after = user.deletion_due_at ? "pending_deletion" : "active"
		this.audit.record("moderation.unban", {
			req,
			target: { type: "user", id: user.id },
			data: { before: { status: "banned" }, after: { status: after, reason } },
		})
		return { unbanned: true }
	}

	list(query: ModerationQueryDto): Page<ModerationAction> {
		const targetUserId = query.user_id
			? (this.refs.findUser(query.user_id)?.id ?? -1)
			: undefined
		const page = this.repository.page(
			{ action: query.action, active: query.active, targetUserId },
			query,
		)
		const users = this.refs.users(
			page.items.flatMap((row) => [row.target_user_id, row.created_by]),
		)
		const items: ModerationAction[] = []
		for (const row of page.items) {
			const user = users.get(row.target_user_id)
			if (!user) continue
			items.push({
				id: String(row.id),
				action: row.action,
				user,
				by: row.created_by === null ? null : (users.get(row.created_by) ?? null),
				public_reason: row.public_reason,
				private_reason: row.private_reason,
				until: row.expires_at?.toISOString() ?? null,
				active: row.active === 1,
				at: row.created_at.toISOString(),
			})
		}
		return { ...page, items }
	}

	/** Nobody moderates themselves or someone at or above their own level. */
	private assertCanModerate(executorId: number, targetId: number): void {
		const error = actOnUserError({
			executorId,
			executor: this.permissions.forUser(executorId),
			targetId,
			target: this.permissions.forUser(targetId),
			self: "deny",
		})
		if (error) throw new GezcezError(error.code, error.reason)
	}

	/** Lifting a ban needs at least the level of whoever placed it (root lifts any ban). */
	private assertCanLift(executorId: number, bannedBy: number | null | undefined): void {
		if (bannedBy === null || bannedBy === undefined || bannedBy === executorId) return
		const executor = this.permissions.forUser(executorId)
		if (executor.root) return
		const banner = this.permissions.forUser(bannedBy)
		if (banner.root || effectiveLevel(executor) < highestLevel(banner))
			throw new GezcezError(
				"ROLE_LEVEL_TOO_LOW",
				"The ban was placed by someone above your role level",
			)
	}
}
