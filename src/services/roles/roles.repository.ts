// roles.repository.ts
// Permission keys and routes (rebuilt from code at boot), roles, and role assignments.

import { Injectable } from "@nestjs/common"
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import {
	citiesTable,
	networksTable,
	permissionRoutesTable,
	permissionsTable,
	rolePermissionsTable,
	rolesTable,
	userRolesTable,
	type I18nText,
	type PermissionRow,
	type PermissionScope,
	type RoleRow,
	type UserRoleRow,
} from "@schemas/core"

export type { PermissionRow, RoleRow, UserRoleRow }

export interface GrantRow {
	network_id: number | null
	role_key: string
	level: number
	permission_key: string | null
}

export interface AssignmentDetail {
	role: Pick<RoleRow, "id" | "key" | "name" | "level">
	network: {
		id: number
		slug: string
		name: string
		city: { id: number; slug: string; name: I18nText }
	} | null
}

export interface RouteRecord {
	method: string
	path: string
	permission_key: string
	scope: PermissionScope
	sudo: boolean
	description: string
}

@Injectable()
export class RolesRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	/** Every (role, permission) pair a user holds, one row per pair (or per role without any). */
	grantsForUser(userId: number): GrantRow[] {
		return this.db
			.select({
				network_id: userRolesTable.network_id,
				role_key: rolesTable.key,
				level: rolesTable.level,
				permission_key: rolePermissionsTable.permission_key,
			})
			.from(userRolesTable)
			.innerJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
			.leftJoin(rolePermissionsTable, eq(rolePermissionsTable.role_id, rolesTable.id))
			.where(and(eq(userRolesTable.user_id, userId), isNull(userRolesTable.revoked_at)))
			.all()
	}

	assignmentsForUser(userId: number): AssignmentDetail[] {
		return this.db
			.select({
				role: {
					id: rolesTable.id,
					key: rolesTable.key,
					name: rolesTable.name,
					level: rolesTable.level,
				},
				network_id: networksTable.id,
				network_slug: networksTable.slug,
				network_name: networksTable.name,
				city_id: citiesTable.id,
				city_slug: citiesTable.slug,
				city_name: citiesTable.name,
			})
			.from(userRolesTable)
			.innerJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
			.leftJoin(networksTable, eq(networksTable.id, userRolesTable.network_id))
			.leftJoin(citiesTable, eq(citiesTable.id, networksTable.city_id))
			.where(and(eq(userRolesTable.user_id, userId), isNull(userRolesTable.revoked_at)))
			.orderBy(asc(userRolesTable.network_id), sql`${rolesTable.level} desc`)
			.all()
			.map((row) => ({
				role: row.role,
				network:
					row.network_id === null
						? null
						: {
								id: row.network_id,
								slug: row.network_slug!,
								name: row.network_name!,
								city: {
									id: row.city_id!,
									slug: row.city_slug!,
									name: row.city_name!,
								},
							},
			}))
	}

	findNetworkId(param: string): number | undefined {
		const condition = /^\d{1,10}$/.test(param)
			? eq(networksTable.id, Number(param))
			: eq(networksTable.slug, param)
		return this.db.select({ id: networksTable.id }).from(networksTable).where(condition).get()
			?.id
	}

	findRoleById(id: number): RoleRow | undefined {
		return this.db.select().from(rolesTable).where(eq(rolesTable.id, id)).get()
	}

	findRoleByKey(key: string): RoleRow | undefined {
		return this.db.select().from(rolesTable).where(eq(rolesTable.key, key)).get()
	}

	findActiveAssignment(
		userId: number,
		roleId: number,
		networkId: number | null,
	): UserRoleRow | undefined {
		return this.db
			.select()
			.from(userRolesTable)
			.where(
				and(
					eq(userRolesTable.user_id, userId),
					eq(userRolesTable.role_id, roleId),
					eq(userRolesTable.network_key, networkId ?? 0),
					isNull(userRolesTable.revoked_at),
				),
			)
			.get()
	}

	insertAssignment(input: {
		userId: number
		roleId: number
		networkId: number | null
		grantedBy: number
		now: Date
	}): UserRoleRow {
		return this.db
			.insert(userRolesTable)
			.values({
				user_id: input.userId,
				role_id: input.roleId,
				network_id: input.networkId,
				granted_by: input.grantedBy,
				granted_at: input.now,
			})
			.returning()
			.get()
	}

	revokeAssignment(id: number, revokedBy: number, now: Date): void {
		this.db
			.update(userRolesTable)
			.set({ revoked_by: revokedBy, revoked_at: now })
			.where(eq(userRolesTable.id, id))
			.run()
	}

	// Registry (boot)

	/** Upserts the keys from code and marks the rest orphaned, in one transaction. */
	syncPermissions(
		keys: { key: string; scope: PermissionScope; description: string; sudo: boolean }[],
		now: Date,
	): { orphaned: number } {
		return this.db.transaction((tx) => {
			for (const key of keys) {
				tx.insert(permissionsTable)
					.values({ ...key, first_seen_at: now, last_seen_at: now, orphaned_at: null })
					.onConflictDoUpdate({
						target: permissionsTable.key,
						set: {
							scope: key.scope,
							description: key.description,
							sudo: key.sudo,
							last_seen_at: now,
							orphaned_at: null,
						},
					})
					.run()
			}
			const orphaned = tx
				.update(permissionsTable)
				.set({ orphaned_at: now })
				.where(
					and(
						notInArray(
							permissionsTable.key,
							keys.map((key) => key.key),
						),
						isNull(permissionsTable.orphaned_at),
					),
				)
				.returning({ key: permissionsTable.key })
				.all()
			return { orphaned: orphaned.length }
		})
	}

	/** Replaces the route registry with the routes found in code. */
	syncRoutes(routes: RouteRecord[], now: Date): void {
		this.db.transaction((tx) => {
			for (const route of routes) {
				tx.insert(permissionRoutesTable)
					.values({ ...route, updated_at: now })
					.onConflictDoUpdate({
						target: [permissionRoutesTable.method, permissionRoutesTable.path],
						set: {
							permission_key: route.permission_key,
							scope: route.scope,
							sudo: route.sudo,
							description: route.description,
							updated_at: now,
						},
					})
					.run()
			}
			const stale = tx
				.select({
					id: permissionRoutesTable.id,
					method: permissionRoutesTable.method,
					path: permissionRoutesTable.path,
				})
				.from(permissionRoutesTable)
				.all()
				.filter(
					(row) =>
						!routes.some(
							(route) => route.method === row.method && route.path === row.path,
						),
				)
				.map((row) => row.id)
			if (stale.length)
				tx.delete(permissionRoutesTable)
					.where(inArray(permissionRoutesTable.id, stale))
					.run()
		})
	}

	listPermissions(): PermissionRow[] {
		return this.db.select().from(permissionsTable).orderBy(asc(permissionsTable.key)).all()
	}

	listRoutes(): (RouteRecord & { id: number })[] {
		return this.db
			.select({
				id: permissionRoutesTable.id,
				method: permissionRoutesTable.method,
				path: permissionRoutesTable.path,
				permission_key: permissionRoutesTable.permission_key,
				scope: permissionRoutesTable.scope,
				sudo: permissionRoutesTable.sudo,
				description: permissionRoutesTable.description,
			})
			.from(permissionRoutesTable)
			.orderBy(asc(permissionRoutesTable.path), asc(permissionRoutesTable.method))
			.all()
	}
}
