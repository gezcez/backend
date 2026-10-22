// roles-admin.service.ts
// Role CRUD and permission sets for the dashboard (plan 6.4): roles are edited only by someone
// whose global level is above the role's (and above any new level), immutable roles change only
// through the seed, and a permission can be added to a role only by someone who holds it
// globally. Every write drops the whole permission cache, since a role edit affects all holders.

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { effectiveLevel, permissionsNotHeld } from "@common/authorization"
import { GezcezError, type ErrorCode } from "@common/errors"
import {
	isPermissionKey,
	PERMISSION_KEYS,
	PERMISSIONS,
	type PermissionKey,
} from "@common/permission-keys"
import { AuditService } from "@services/audit/audit.service"
import { RefsService } from "@services/refs/refs.service"
import { PermissionCacheService } from "./permission-cache.service"
import { PermissionRegistryService } from "./permission-registry.service"
import { RolesAdminRepository, type RoleWithCounts } from "./roles-admin.repository"
import type {
	CreateRoleDto,
	PermissionBatchDto,
	PermissionBatchResultDto,
	PermissionInfo,
	PermissionMatrixDto,
	PermissionRegistryEntry,
	Role,
	RoleDetail,
	UpdateRoleDto,
} from "./roles.dto"

function toRole(role: RoleWithCounts): Role {
	return {
		id: role.id,
		key: role.key,
		name: role.name,
		description: role.description ?? "",
		level: role.level,
		immutable: role.immutable,
		permission_count: role.key === "root" ? PERMISSION_KEYS.length : role.permission_count,
		member_count: role.member_count,
	}
}

@Injectable()
export class RolesAdminService {
	constructor(
		private readonly repository: RolesAdminRepository,
		private readonly cache: PermissionCacheService,
		private readonly registry: PermissionRegistryService,
		private readonly refs: RefsService,
		private readonly audit: AuditService,
	) {}

	list(): Role[] {
		return this.repository.roles().map(toRole)
	}

	detail(roleId: number): RoleDetail {
		const role = this.find(roleId)
		const networks = this.refs.networks(
			this.repository.membersByNetwork(role.id).map((row) => row.network_id),
		)
		return {
			...toRole(role),
			permissions: this.permissionsOf(role),
			members_by_network: this.repository.membersByNetwork(role.id).map((row) => ({
				network: row.network_id === null ? null : (networks.get(row.network_id) ?? null),
				count: row.count,
			})),
			created_at: role.created_at.toISOString(),
			updated_at: (role.updated_at ?? role.created_at).toISOString(),
		}
	}

	create(req: Request, body: CreateRoleDto): Role {
		const executorId = req.auth!.userId
		this.assertLevelBelowMine(executorId, body.level)
		if (this.repository.keyExists(body.key))
			throw new GezcezError("CONFLICT", "A role with this key exists", {
				fields: { key: "taken" },
			})
		const row = this.repository.createRole({
			...body,
			by: executorId,
			now: new Date(),
		})
		this.audit.record("roles.created", {
			req,
			target: { type: "role", id: row.id },
			data: { after: { key: row.key, name: row.name, level: row.level } },
		})
		return toRole({ ...row, permission_count: 0, member_count: 0 })
	}

	update(req: Request, roleId: number, body: UpdateRoleDto): Role {
		const executorId = req.auth!.userId
		const role = this.editable(executorId, roleId)
		if (body.level !== undefined) this.assertLevelBelowMine(executorId, body.level)
		const patch = {
			...(body.name !== undefined ? { name: body.name } : {}),
			...(body.description !== undefined ? { description: body.description } : {}),
			...(body.level !== undefined ? { level: body.level } : {}),
		}
		this.repository.updateRole(role.id, patch, executorId, new Date())
		this.cache.invalidate()
		this.audit.record("roles.updated", {
			req,
			target: { type: "role", id: role.id },
			data: {
				before: Object.fromEntries(
					Object.keys(patch).map((key) => [key, role[key as keyof typeof patch]]),
				),
				after: patch,
			},
		})
		return toRole(this.find(role.id))
	}

	matrix(): PermissionMatrixDto {
		const roles = this.repository.roles()
		const grants = this.repository.grants()
		return {
			roles: roles.map(toRole),
			permissions: this.permissionInfo(),
			grants: roles.map((role) => ({
				role_id: role.id,
				permissions: this.permissionsOf(role, grants.get(role.id)),
			})),
		}
	}

	/** Replaces a role's permission set; every added key must be held by the caller. */
	replacePermissions(req: Request, roleId: number, keys: PermissionKey[]): RoleDetail {
		const executorId = req.auth!.userId
		const role = this.editable(executorId, roleId)
		const current = new Set(this.repository.grants([role.id]).get(role.id) ?? [])
		const wanted = new Set(keys)
		const added = [...wanted].filter((key) => !current.has(key))
		const removed = [...current].filter((key) => !wanted.has(key as PermissionKey))
		const notHeld = permissionsNotHeld(this.cache.forUser(executorId), added)
		if (notHeld.length)
			throw new GezcezError("PERMISSION_MISSING", "You can only grant permissions you hold", {
				permissions: notHeld,
			})
		this.apply(req, executorId, [
			...added.map((key) => ({ roleId: role.id, key, op: "grant" as const })),
			...removed.map((key) => ({ roleId: role.id, key, op: "revoke" as const })),
		])
		return this.detail(role.id)
	}

	/** The matrix editor's batch: each operation is checked on its own and reported. */
	batch(req: Request, body: PermissionBatchDto): PermissionBatchResultDto {
		const executorId = req.auth!.userId
		const executor = this.cache.forUser(executorId)
		const roles = new Map(this.repository.roles().map((role) => [role.id, role]))
		const accepted: { roleId: number; key: string; op: "grant" | "revoke" }[] = []
		const results = body.operations.map((operation) => {
			const error = ((): ErrorCode | null => {
				const role = roles.get(operation.role_id)
				if (!role) return "NOT_FOUND"
				if (role.immutable) return "ROLE_IMMUTABLE"
				if (!executor.root && effectiveLevel(executor) <= role.level)
					return "ROLE_LEVEL_TOO_LOW"
				if (
					operation.op === "grant" &&
					permissionsNotHeld(executor, [operation.permission_key]).length
				)
					return "PERMISSION_MISSING"
				return null
			})()
			if (!error)
				accepted.push({
					roleId: operation.role_id,
					key: operation.permission_key,
					op: operation.op,
				})
			return { ...operation, ok: error === null, error_code: error }
		})
		if (accepted.length) this.apply(req, executorId, accepted)
		return { results }
	}

	permissionInfo(): PermissionInfo[] {
		const sudo = new Set(
			this.registry
				.registered()
				.filter((route) => route.sudo)
				.map((route) => route.permission_key),
		)
		return PERMISSION_KEYS.map((key) => ({
			key,
			scope: PERMISSIONS[key].scope === "global" ? "global" : "network",
			sudo: sudo.has(key),
			description: PERMISSIONS[key].description,
		}))
	}

	registryEntries(): PermissionRegistryEntry[] {
		const routes = this.repository.routes()
		const grants = this.repository.grants()
		const roles = this.repository.roles()
		return this.repository.permissions().map((row) => ({
			key: row.key,
			scope: row.scope,
			sudo: row.sudo,
			description: row.description,
			routes: routes
				.filter((route) => route.permission_key === row.key)
				.map(({ method, path, sudo }) => ({ method, path, sudo })),
			roles: roles
				.filter(
					(role) =>
						(role.key === "root" && row.orphaned_at === null) ||
						(grants.get(role.id) ?? []).includes(row.key),
				)
				.map(({ id, key, name, level }) => ({ id, key, name, level })),
			first_registered_at: row.first_seen_at.toISOString(),
			last_seen_at: (row.last_seen_at ?? row.first_seen_at).toISOString(),
			orphaned_at: row.orphaned_at?.toISOString() ?? null,
		}))
	}

	/** Only keys no longer in code can be deleted; their role grants go with them. */
	deletePermission(req: Request, key: string): { deleted: boolean } {
		const row = this.repository.permission(key)
		if (!row) throw new GezcezError("NOT_FOUND", "Unknown permission key")
		if (row.orphaned_at === null || isPermissionKey(key))
			throw new GezcezError("CONFLICT", "Only orphaned keys can be deleted")
		const roles = [...this.repository.grants().entries()]
			.filter(([, keys]) => keys.includes(key))
			.map(([roleId]) => roleId)
		const deleted = this.repository.deletePermission(key)
		this.cache.invalidate()
		this.audit.record("permissions.deleted", {
			req,
			target: { type: "permission", id: key },
			data: { before: { key, roles } },
		})
		return { deleted }
	}

	private apply(
		req: Request,
		executorId: number,
		changes: { roleId: number; key: string; op: "grant" | "revoke" }[],
	): void {
		if (changes.length === 0) return
		this.repository.changePermissions(changes, executorId, new Date())
		this.cache.invalidate()
		for (const roleId of new Set(changes.map((change) => change.roleId))) {
			const mine = changes.filter((change) => change.roleId === roleId)
			this.audit.record("roles.permissions_changed", {
				req,
				target: { type: "role", id: roleId },
				data: {
					after: {
						added: mine.filter((c) => c.op === "grant").map((c) => c.key),
						removed: mine.filter((c) => c.op === "revoke").map((c) => c.key),
					},
				},
			})
		}
	}

	private permissionsOf(role: RoleWithCounts, keys?: string[]): PermissionKey[] {
		if (role.key === "root") return [...PERMISSION_KEYS]
		return (keys ?? this.repository.grants([role.id]).get(role.id) ?? []).filter(
			isPermissionKey,
		)
	}

	private find(roleId: number): RoleWithCounts {
		const role = this.repository.role(roleId)
		if (!role) throw new GezcezError("NOT_FOUND", "Role not found")
		return role
	}

	/** A role the executor may change: not immutable and below the executor's global level. */
	private editable(executorId: number, roleId: number): RoleWithCounts {
		const role = this.find(roleId)
		if (role.immutable) throw new GezcezError("ROLE_IMMUTABLE")
		this.assertLevelBelowMine(executorId, role.level)
		return role
	}

	private assertLevelBelowMine(executorId: number, level: number): void {
		const executor = this.cache.forUser(executorId)
		if (!executor.root && effectiveLevel(executor) <= level)
			throw new GezcezError("ROLE_LEVEL_TOO_LOW", "Role levels must stay below your own")
	}
}
