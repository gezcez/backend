// roles.service.ts
// Role assignment with the level rules of plan section 6.4 (the dashboard endpoints that call
// this arrive in P2), the permission registry view, and the data behind GET /v1/me.

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { assignmentError } from "@common/authorization"
import { GezcezError, type ErrorCode } from "@common/errors"
import { AuditService } from "@services/audit/audit.service"
import { PermissionCacheService } from "./permission-cache.service"
import { RolesRepository, type AssignmentDetail, type UserRoleRow } from "./roles.repository"

export interface AssignmentInput {
	targetUserId: number
	/** One of roleKey or roleId. */
	roleKey?: string
	roleId?: number
	/** Undefined for a global assignment. */
	networkId?: number
}

export interface RoleOperation {
	role_id: number
	op: "grant" | "revoke"
}

export interface RoleOperationResult extends RoleOperation {
	ok: boolean
	error_code: ErrorCode | null
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

	/** `idempotent`: revoking a role the user does not hold is a no-op instead of NOT_FOUND. */
	revoke(req: Request, input: AssignmentInput, idempotent = false): void {
		const { executorId, role } = this.check(req, input)
		const existing = this.repository.findActiveAssignment(
			input.targetUserId,
			role.id,
			input.networkId ?? null,
		)
		if (!existing) {
			if (idempotent) return
			throw new GezcezError("NOT_FOUND", "The user does not hold this role here")
		}
		this.repository.revokeAssignment(existing.id, executorId, new Date())
		this.cache.invalidate(input.targetUserId)
		this.audit.record("roles.revoke", {
			req,
			target: { type: "user", id: input.targetUserId },
			networkId: input.networkId ?? null,
			data: { role: role.key },
		})
	}

	/**
	 * Batch grant/revoke from the role editors. Each operation is checked and applied on its own;
	 * a failure is reported in its result and does not stop the others.
	 */
	applyOperations(
		req: Request,
		targetUserId: number,
		operations: RoleOperation[],
		networkId?: number,
	): RoleOperationResult[] {
		return operations.map((operation) => {
			const input = { targetUserId, roleId: operation.role_id, networkId }
			try {
				if (operation.op === "grant") this.grant(req, input)
				else this.revoke(req, input, true)
				return { ...operation, ok: true, error_code: null }
			} catch (error) {
				if (!(error instanceof GezcezError)) throw error
				return { ...operation, ok: false, error_code: error.code }
			}
		})
	}

	assignments(userId: number): AssignmentDetail[] {
		return this.repository.assignmentsForUser(userId)
	}

	private check(req: Request, input: AssignmentInput) {
		const executorId = req.auth?.userId
		if (executorId === undefined) throw new GezcezError("AUTH_REQUIRED")
		const role =
			input.roleId !== undefined
				? this.repository.findRoleById(input.roleId)
				: input.roleKey !== undefined
					? this.repository.findRoleByKey(input.roleKey)
					: undefined
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
