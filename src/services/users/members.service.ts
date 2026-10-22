// members.service.ts
// Network members, the "add member" lookup and the roles a caller may assign in a network.

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { effectiveLevel } from "@common/authorization"
import { PERMISSIONS, isPermissionKey } from "@common/permission-keys"
import type { Page } from "@common/response"
import { maskEmail } from "@common/utils"
import { RefsService } from "@services/refs/refs.service"
import { PermissionCacheService } from "@services/roles/permission-cache.service"
import { RolesAdminRepository } from "@services/roles/roles-admin.repository"
import type { RoleRef } from "@services/roles/roles.dto"
import type { z } from "zod"
import { DashUsersService } from "./dash-users.service"
import type { MemberQueryDto, MemberSchema } from "./members.dto"

type Member = z.infer<typeof MemberSchema>

@Injectable()
export class MembersService {
	constructor(
		private readonly repository: RolesAdminRepository,
		private readonly users: DashUsersService,
		private readonly refs: RefsService,
		private readonly cache: PermissionCacheService,
	) {}

	list(networkId: number, query: MemberQueryDto): Page<Member> {
		const page = this.repository.members(networkId, { roleKey: query.role }, query)
		const assignments = this.repository.networkAssignments(
			networkId,
			page.items.map((row) => row.id),
		)
		const grantors = this.refs.users(assignments.map((a) => a.granted_by))
		return {
			...page,
			items: page.items.map((row) => ({
				user: { id: row.public_id, display_name: row.display_name, username: row.username },
				email_masked: maskEmail(row.email),
				last_active_at: row.last_active_ms
					? new Date(row.last_active_ms).toISOString()
					: null,
				roles: assignments
					.filter((a) => a.user_id === row.id)
					.map((a) => ({
						role: {
							id: a.role_id,
							key: a.role_key,
							name: a.role_name,
							level: a.role_level,
						},
						granted_at: a.granted_at.toISOString(),
						granted_by:
							a.granted_by === null ? null : (grantors.get(a.granted_by) ?? null),
					})),
			})),
		}
	}

	candidates(req: Request, q: string) {
		const term = q.replace(/^@/, "")
		return term.length < 2 ? [] : this.users.candidates(req, term)
	}

	/**
	 * Roles strictly below the caller's level in this network that mean something there: not
	 * immutable, and holding a network-only key (or no keys yet).
	 */
	assignableRoles(req: Request, networkId: number): RoleRef[] {
		const executor = this.cache.forUser(req.auth!.userId)
		const level = executor.root ? Number.POSITIVE_INFINITY : effectiveLevel(executor, networkId)
		const grants = this.repository.grants()
		return this.repository
			.roles()
			.filter((role) => !role.immutable && role.level < level)
			.filter((role) => {
				const keys = (grants.get(role.id) ?? []).filter(isPermissionKey)
				return keys.length === 0 || keys.some((key) => PERMISSIONS[key].scope === "network")
			})
			.map(({ id, key, name, level }) => ({ id, key, name, level }))
	}
}
