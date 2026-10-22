// roles-admin.repository.ts
// Role CRUD, role permission sets, the permission registry view, orphan deletion and network
// member lists.

import { Injectable } from "@nestjs/common"
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"
import type { Page, PageQuery } from "@common/response"
import { InjectCoreDb, paginate, type CoreDatabase } from "@db"
import {
	permissionRoutesTable,
	permissionsTable,
	rolePermissionsTable,
	rolesTable,
	userRolesTable,
	usersTable,
	type PermissionRow,
	type RoleRow,
} from "@schemas/core"

export type RoleWithCounts = RoleRow & { permission_count: number; member_count: number }

export interface MemberRow {
	id: number
	public_id: string
	display_name: string
	username: string | null
	email: string
	last_active_ms: number | null
}

export interface MemberAssignment {
	user_id: number
	role_id: number
	role_key: string
	role_name: string
	role_level: number
	granted_at: Date
	granted_by: number | null
}

@Injectable()
export class RolesAdminRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	// Explicit table names in correlated subqueries (drizzle leaves sql-template columns
	// unqualified).
	private readonly permissionCount = sql<number>`(select count(*) from role_permissions rp where rp.role_id = "roles"."id")`
	private readonly memberCount = sql<number>`(select count(*) from user_roles ur where ur.role_id = "roles"."id" and ur.revoked_at is null)`

	roles(): RoleWithCounts[] {
		return this.db
			.select({
				role: rolesTable,
				permission_count: this.permissionCount,
				member_count: this.memberCount,
			})
			.from(rolesTable)
			.where(isNull(rolesTable.deleted_at))
			.orderBy(sql`${rolesTable.level} desc`, asc(rolesTable.key))
			.all()
			.map(({ role, ...counts }) => ({ ...role, ...counts }))
	}

	role(id: number): RoleWithCounts | undefined {
		return this.roles().find((role) => role.id === id)
	}

	keyExists(key: string): boolean {
		return !!this.db
			.select({ id: rolesTable.id })
			.from(rolesTable)
			.where(eq(rolesTable.key, key))
			.get()
	}

	createRole(input: {
		key: string
		name: string
		description: string
		level: number
		by: number
		now: Date
	}): RoleRow {
		return this.db
			.insert(rolesTable)
			.values({
				key: input.key,
				name: input.name,
				description: input.description,
				level: input.level,
				immutable: false,
				created_by: input.by,
				created_at: input.now,
			})
			.returning()
			.get()
	}

	updateRole(
		id: number,
		patch: Partial<Pick<RoleRow, "name" | "description" | "level">>,
		by: number,
		now: Date,
	): void {
		this.db
			.update(rolesTable)
			.set({ ...patch, updated_by: by, updated_at: now })
			.where(eq(rolesTable.id, id))
			.run()
	}

	/** role id to its permission keys. */
	grants(roleIds?: number[]): Map<number, string[]> {
		const rows = this.db
			.select({
				role_id: rolePermissionsTable.role_id,
				key: rolePermissionsTable.permission_key,
			})
			.from(rolePermissionsTable)
			.where(roleIds ? inArray(rolePermissionsTable.role_id, roleIds) : undefined)
			.orderBy(asc(rolePermissionsTable.permission_key))
			.all()
		const map = new Map<number, string[]>()
		for (const row of rows) {
			const list = map.get(row.role_id) ?? []
			list.push(row.key)
			map.set(row.role_id, list)
		}
		return map
	}

	/** Grants and revokes role permissions in one transaction. */
	changePermissions(
		changes: { roleId: number; key: string; op: "grant" | "revoke" }[],
		by: number,
		now: Date,
	): void {
		this.db.transaction((tx) => {
			for (const change of changes) {
				if (change.op === "grant") {
					tx.insert(rolePermissionsTable)
						.values({
							role_id: change.roleId,
							permission_key: change.key,
							created_by: by,
							created_at: now,
						})
						.onConflictDoNothing()
						.run()
				} else {
					tx.delete(rolePermissionsTable)
						.where(
							and(
								eq(rolePermissionsTable.role_id, change.roleId),
								eq(rolePermissionsTable.permission_key, change.key),
							),
						)
						.run()
				}
			}
			for (const roleId of new Set(changes.map((change) => change.roleId))) {
				tx.update(rolesTable)
					.set({ updated_by: by, updated_at: now })
					.where(eq(rolesTable.id, roleId))
					.run()
			}
		})
	}

	membersByNetwork(roleId: number): { network_id: number | null; count: number }[] {
		return this.db
			.select({ network_id: userRolesTable.network_id, count: sql<number>`count(*)` })
			.from(userRolesTable)
			.where(and(eq(userRolesTable.role_id, roleId), isNull(userRolesTable.revoked_at)))
			.groupBy(userRolesTable.network_id)
			.all()
	}

	// Registry

	permissions(): PermissionRow[] {
		return this.db.select().from(permissionsTable).orderBy(asc(permissionsTable.key)).all()
	}

	routes(): { method: string; path: string; permission_key: string; sudo: boolean }[] {
		return this.db
			.select({
				method: permissionRoutesTable.method,
				path: permissionRoutesTable.path,
				permission_key: permissionRoutesTable.permission_key,
				sudo: permissionRoutesTable.sudo,
			})
			.from(permissionRoutesTable)
			.orderBy(asc(permissionRoutesTable.path), asc(permissionRoutesTable.method))
			.all()
	}

	permission(key: string): PermissionRow | undefined {
		return this.db.select().from(permissionsTable).where(eq(permissionsTable.key, key)).get()
	}

	/** Deletes a key with its role grants and routes (foreign keys cascade). */
	deletePermission(key: string): boolean {
		return (
			this.db
				.delete(permissionsTable)
				.where(eq(permissionsTable.key, key))
				.returning({ key: permissionsTable.key })
				.all().length > 0
		)
	}

	// Network members

	private readonly memberLastActive = sql<
		number | null
	>`nullif(max(coalesce("users"."last_login_at", 0), coalesce((select max(s.last_seen_at) from sessions s where s.user_id = "users"."id"), 0)), 0)`

	members(networkId: number, filter: { roleKey?: string }, query: PageQuery): Page<MemberRow> {
		const memberOf = (extra?: SQL) =>
			sql`exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = "users"."id" and ur.network_id = ${networkId} and ur.revoked_at is null${extra ? sql` and ${extra}` : sql``})`
		const conditions: SQL[] = [
			memberOf(filter.roleKey !== undefined ? sql`r.key = ${filter.roleKey}` : undefined),
		]
		const q = query.q?.trim().toLowerCase()
		if (q) {
			const pattern = q.replace(/[\\%_]/g, (c) => `\\${c}`)
			conditions.push(
				sql`(lower("users"."display_name") like ${`%${pattern}%`} escape '\\' or lower("users"."username") like ${`${pattern}%`} escape '\\')`,
			)
		}
		const where = and(...conditions)
		const level = sql`(select max(r.level) from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = "users"."id" and ur.network_id = ${networkId} and ur.revoked_at is null)`
		return paginate({
			query,
			filters: { networkId, ...filter },
			sortable: {
				display_name: sql`lower(${usersTable.display_name})`,
				level,
				last_active_at: this.memberLastActive,
			},
			defaultSort: "level:desc",
			tieBreaker: usersTable.id,
			fetch: (orderBy, limit, offset) =>
				this.db
					.select({
						id: usersTable.id,
						public_id: usersTable.public_id,
						display_name: usersTable.display_name,
						username: usersTable.username,
						email: usersTable.email,
						last_active_ms: this.memberLastActive,
					})
					.from(usersTable)
					.where(where)
					.orderBy(...orderBy)
					.limit(limit)
					.offset(offset)
					.all(),
			count: (cap) =>
				this.db
					.select({ one: sql`1` })
					.from(usersTable)
					.where(where)
					.limit(cap)
					.all().length,
		})
	}

	networkAssignments(networkId: number, userIds: number[]): MemberAssignment[] {
		if (userIds.length === 0) return []
		return this.db
			.select({
				user_id: userRolesTable.user_id,
				role_id: rolesTable.id,
				role_key: rolesTable.key,
				role_name: rolesTable.name,
				role_level: rolesTable.level,
				granted_at: userRolesTable.granted_at,
				granted_by: userRolesTable.granted_by,
			})
			.from(userRolesTable)
			.innerJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
			.where(
				and(
					eq(userRolesTable.network_id, networkId),
					inArray(userRolesTable.user_id, userIds),
					isNull(userRolesTable.revoked_at),
				),
			)
			.orderBy(sql`${rolesTable.level} desc`)
			.all()
	}
}
