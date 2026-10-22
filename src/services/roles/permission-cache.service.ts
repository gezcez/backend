// permission-cache.service.ts
// PermissionCacheService.forUser(userId): the user's global and per-network permission sets and
// role levels, built from user_roles + role_permissions, cached 60 s, invalidated on any role or
// assignment write (plan section 6.4). Implements the PermissionResolver of common/.

import { Injectable } from "@nestjs/common"
import {
	emptyPermissions,
	type PermissionResolver,
	type UserPermissions,
} from "@common/authorization"
import { isPermissionKey } from "@common/permission-keys"
import { RolesRepository } from "./roles.repository"

export const PERMISSION_CACHE_TTL_MS = 60_000

@Injectable()
export class PermissionCacheService implements PermissionResolver {
	private readonly cache = new Map<number, { value: UserPermissions; until: number }>()
	private hits = 0
	private misses = 0

	constructor(private readonly repository: RolesRepository) {}

	forUser(userId: number): UserPermissions {
		const now = Date.now()
		const cached = this.cache.get(userId)
		if (cached && cached.until > now) {
			this.hits++
			return cached.value
		}
		this.misses++
		const value = this.build(userId)
		this.cache.set(userId, { value, until: now + PERMISSION_CACHE_TTL_MS })
		return value
	}

	resolveNetwork(param: string): number | undefined {
		return this.repository.findNetworkId(param)
	}

	/** Drops one user's entry, or everything (role permission edits affect many users). */
	invalidate(userId?: number): void {
		if (userId === undefined) this.cache.clear()
		else this.cache.delete(userId)
	}

	stats(): { size: number; hits: number; misses: number } {
		return { size: this.cache.size, hits: this.hits, misses: this.misses }
	}

	private build(userId: number): UserPermissions {
		const permissions = emptyPermissions()
		for (const grant of this.repository.grantsForUser(userId)) {
			if (grant.role_key === "root" && grant.network_id === null) permissions.root = true
			if (grant.network_id === null) {
				permissions.globalLevel = Math.max(permissions.globalLevel, grant.level)
			} else {
				const level = permissions.networkLevels.get(grant.network_id) ?? 0
				permissions.networkLevels.set(grant.network_id, Math.max(level, grant.level))
			}
			const key = grant.permission_key
			if (!key || !isPermissionKey(key)) continue
			if (grant.network_id === null) {
				permissions.global.add(key)
			} else {
				let set = permissions.byNetwork.get(grant.network_id)
				if (!set) permissions.byNetwork.set(grant.network_id, (set = new Set()))
				set.add(key)
			}
		}
		return permissions
	}
}
