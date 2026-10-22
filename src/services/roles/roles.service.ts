// roles.service.ts
// Role assignment with the level rules of plan section 6.4 (the dashboard endpoints that call
// this arrive in P2), the permission registry view, and the data behind GET /v1/me.

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { assignmentError } from "@common/authorization"
import { GezcezError } from "@common/errors"
import { AuditService } from "@services/audit/audit.service"
import { PermissionCacheService } from "./permission-cache.service"
import type { PermissionListDto } from "./roles.dto"
import { RolesRepository, type AssignmentDetail, type UserRoleRow } from "./roles.repository"

export interface AssignmentInput {
	targetUserId: number
	roleKey: string
	/** Undefined for a global assignment. */
	networkId?: number
}

@Injectable()
export class RolesService {
	constructor(
		private readonly repository: RolesRepository,
		private readonly cache: PermissionCacheService,
		private readonly audit: AuditService,
	) {}

	grant(req: Request, input: AssignmentInput): UserRoleRow {
		const { executorId, role } = this.check(req, input)
		const networkId = input.networkId ?? null
		const existing = this.repository.findActiveAssignment(
			input.targetUserId,
			role.id,
			networkId,
		)
		if (existing) return existing
		const row = this.repository.insertAssignment({
			userId: input.targetUserId,
			roleId: role.id,
			networkId,
			grantedBy: executorId,
			now: new Date(),
		})
		this.cache.invalidate(input.targetUserId)
		this.audit.record("roles.grant", {
			req,
			target: { type: "user", id: input.targetUserId },
			networkId,
			data: { role: role.key },
		})
		return row
	}

	revoke(req: Request, input: AssignmentInput): void {
		const { executorId, role } = this.check(req, input)
		const existing = this.repository.findActiveAssignment(
			input.targetUserId,
			role.id,
			input.networkId ?? null,
		)
		if (!existing) throw new GezcezError("NOT_FOUND", "The user does not hold this role here")
		this.repository.revokeAssignment(existing.id, executorId, new Date())
		this.cache.invalidate(input.targetUserId)
		this.audit.record("roles.revoke", {
			req,
			target: { type: "user", id: input.targetUserId },
			networkId: input.networkId ?? null,
			data: { role: role.key },
		})
	}

	assignments(userId: number): AssignmentDetail[] {
		return this.repository.assignmentsForUser(userId)
	}

	permissionList(): PermissionListDto {
		return {
			keys: this.repository.listPermissions().map((row) => ({
				key: row.key,
				scope: row.scope,
				description: row.description,
				sudo: row.sudo,
				orphaned: row.orphaned_at !== null,
			})),
			routes: this.repository.listRoutes().map(({ id: _id, ...route }) => route),
		}
	}

	private check(req: Request, input: AssignmentInput) {
		const executorId = req.auth?.userId
		if (executorId === undefined) throw new GezcezError("AUTH_REQUIRED")
		const role = this.repository.findRoleByKey(input.roleKey)
		if (!role) throw new GezcezError("NOT_FOUND", "Unknown role")
		const error = assignmentError({
			executorId,
			executor: this.cache.forUser(executorId),
			targetId: input.targetUserId,
			target: this.cache.forUser(input.targetUserId),
			roleLevel: role.level,
			roleImmutable: role.immutable,
			networkId: input.networkId,
		})
		if (error) throw new GezcezError(error.code, error.reason)
		return { executorId, role }
	}
}
