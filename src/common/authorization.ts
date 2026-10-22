// authorization.ts
// Permission resolution rules (plan section 6.4), kept pure so they are tested on their own:
//  - a global role grants its permissions in every network
//  - a network permission check passes on the global set or that network's set
//  - a global permission check passes only on the global set
//  - root bypasses checks
//  - role assignment needs a strictly higher effective level than the role and the target, and
//    nobody edits themselves

import type { ErrorCode } from "./errors"
import { PERMISSIONS, type PermissionKey } from "./permission-keys"

export interface UserPermissions {
	root: boolean
	global: Set<PermissionKey>
	byNetwork: Map<number, Set<PermissionKey>>
	/** Highest role level held globally (0 when none). */
	globalLevel: number
	/** Highest role level held per network (network grants only). */
	networkLevels: Map<number, number>
}

export function emptyPermissions(): UserPermissions {
	return {
		root: false,
		global: new Set(),
		byNetwork: new Map(),
		globalLevel: 0,
		networkLevels: new Map(),
	}
}

/** `networkId` undefined means a global check. */
export function hasPermission(
	permissions: UserPermissions,
	key: PermissionKey,
	networkId?: number,
): boolean {
	if (permissions.root) return true
	if (permissions.global.has(key)) return true
	if (networkId === undefined) return false
	if (PERMISSIONS[key].scope === "global") return false
	return permissions.byNetwork.get(networkId)?.has(key) ?? false
}

/** Max of the global level and, for a network, that network's level. */
export function effectiveLevel(permissions: UserPermissions, networkId?: number): number {
	const network = networkId === undefined ? 0 : (permissions.networkLevels.get(networkId) ?? 0)
	return Math.max(permissions.globalLevel, network)
}

export interface AssignmentCheck {
	executorId: number
	executor: UserPermissions
	targetId: number
	target: UserPermissions
	roleLevel: number
	roleImmutable: boolean
	/** Undefined for a global assignment. */
	networkId?: number
}

/** Why an executor may not grant or revoke a role, or null when allowed. */
export function assignmentError(
	check: AssignmentCheck,
): { code: ErrorCode; reason: string } | null {
	if (check.roleImmutable)
		return { code: "ROLE_IMMUTABLE", reason: "Immutable roles change only through the seed" }
	if (check.executorId === check.targetId)
		return { code: "ROLE_LEVEL_TOO_LOW", reason: "Nobody edits their own roles" }
	const executorLevel = effectiveLevel(check.executor, check.networkId)
	if (executorLevel <= check.roleLevel)
		return { code: "ROLE_LEVEL_TOO_LOW", reason: "Role level is not below yours" }
	if (executorLevel <= effectiveLevel(check.target, check.networkId))
		return { code: "ROLE_LEVEL_TOO_LOW", reason: "Target's level is not below yours" }
	return null
}

/** Highest level the user holds anywhere (global or any network). */
export function highestLevel(permissions: UserPermissions): number {
	return Math.max(permissions.globalLevel, ...permissions.networkLevels.values())
}

/**
 * Why an executor may not act on another user (ban, unban, end their sessions), or null when
 * allowed: root acts on anyone, everyone else only on users whose highest level is below theirs.
 * `self` decides whether acting on oneself is allowed (ending one's own sessions is).
 */
export function actOnUserError(check: {
	executorId: number
	executor: UserPermissions
	targetId: number
	target: UserPermissions
	self: "allow" | "deny"
}): { code: ErrorCode; reason: string } | null {
	if (check.executorId === check.targetId)
		return check.self === "allow"
			? null
			: { code: "ROLE_LEVEL_TOO_LOW", reason: "You cannot act on yourself" }
	if (check.executor.root) return null
	if (effectiveLevel(check.executor) <= highestLevel(check.target))
		return { code: "ROLE_LEVEL_TOO_LOW", reason: "The user's role level is not below yours" }
	return null
}

/** Keys the executor would grant through a role edit without holding them (globally). */
export function permissionsNotHeld(
	executor: UserPermissions,
	keys: PermissionKey[],
): PermissionKey[] {
	if (executor.root) return []
	return keys.filter((key) => !executor.global.has(key))
}

/** Interface the authorization guard depends on; implemented by the roles module. */
export interface PermissionResolver {
	forUser(userId: number): UserPermissions
	/** Accepts a numeric id or a slug; undefined when no such network exists. */
	resolveNetwork(param: string): number | undefined
}
export const PERMISSION_RESOLVER = Symbol("PERMISSION_RESOLVER")
