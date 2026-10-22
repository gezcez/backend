// dash-users.repository.ts
// Dashboard user search and detail reads, and the admin view of sessions and refresh families.

import { Injectable } from "@nestjs/common"
import {
	and,
	desc,
	eq,
	exists,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	ne,
	or,
	sql,
	type SQL,
} from "drizzle-orm"
import type { Page, PageQuery } from "@common/response"
import { InjectCoreDb, paginate, type CoreDatabase } from "@db"
import {
	moderationActionsTable,
	refreshTokensTable,
	rolesTable,
	sessionsTable,
	userRolesTable,
	usersTable,
	type ModerationActionRow,
	type RefreshTokenRow,
	type SessionRow,
	type UserRow,
} from "@schemas/core"
import type { DashUserStatus } from "./dash-users.dto"

export interface UserSearch {
	q?: string
	/** Also match `q` as an email prefix (callers holding users.pii.read). */
	emailSearch: boolean
	status?: DashUserStatus
	roleKey?: string
	networkId?: number
	from?: Date
	to?: Date
}

export interface UserListRow {
	id: number
	public_id: string
	display_name: string
	username: string | null
	email: string
	status: UserRow["status"]
	email_verified_at: Date | null
	banned_until: Date | null
	deletion_due_at: Date | null
	created_at: Date
	last_active_ms: number | null
	role_count: number
}

export interface AssignmentRow {
	role_id: number
	role_key: string
	role_name: string
	role_level: number
	network_id: number | null
	granted_at: Date
	granted_by: number | null
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

@Injectable()
export class DashUsersRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	// Correlated subqueries name their tables explicitly: drizzle renders columns unqualified
	// inside sql templates, which would bind "id" to the inner table.
	private readonly lastActive = sql<
		number | null
	>`nullif(max(coalesce("users"."last_login_at", 0), coalesce((select max(s.last_seen_at) from sessions s where s.user_id = "users"."id"), 0)), 0)`

	private readonly roleCount = sql<number>`(select count(*) from user_roles ur where ur.user_id = "users"."id" and ur.revoked_at is null)`

	page(search: UserSearch, query: PageQuery): Page<UserListRow> {
		const u = usersTable
		const conditions: SQL[] = [ne(u.status, "deleted")]
		const q = query.q?.trim()
		if (q) {
			const pattern = escapeLike(q.toLowerCase())
			const matches: SQL[] = [
				sql`lower(${u.display_name}) like ${`%${pattern}%`} escape '\\'`,
				sql`lower(${u.username}) like ${`${pattern}%`} escape '\\'`,
				eq(u.public_id, q),
			]
			if (search.emailSearch) matches.push(sql`${u.email} like ${`${pattern}%`} escape '\\'`)
			conditions.push(or(...matches)!)
		}
		switch (search.status) {
			case "active":
				conditions.push(eq(u.status, "active"), isNotNull(u.email_verified_at))
				break
			case "unverified":
				conditions.push(eq(u.status, "active"), isNull(u.email_verified_at))
				break
			case "banned":
			case "pending_deletion":
				conditions.push(eq(u.status, search.status))
				break
		}
		if (search.roleKey !== undefined || search.networkId !== undefined) {
			const roleConditions: SQL[] = [
				eq(userRolesTable.user_id, u.id),
				isNull(userRolesTable.revoked_at),
			]
			if (search.roleKey !== undefined)
				roleConditions.push(eq(rolesTable.key, search.roleKey))
			if (search.networkId !== undefined)
				roleConditions.push(eq(userRolesTable.network_id, search.networkId))
			conditions.push(
				exists(
					this.db
						.select({ one: sql`1` })
						.from(userRolesTable)
						.innerJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
						.where(and(...roleConditions)),
				),
			)
		}
		if (search.from) conditions.push(gte(u.created_at, search.from))
		if (search.to) conditions.push(lte(u.created_at, search.to))
		const where = and(...conditions)
		return paginate({
			query,
			filters: { ...search },
			sortable: {
				created_at: u.created_at,
				display_name: sql`lower(${u.display_name})`,
				last_active_at: this.lastActive,
			},
			defaultSort: "created_at:desc",
			tieBreaker: u.id,
			fetch: (orderBy, limit, offset) =>
				this.db
					.select({
						id: u.id,
						public_id: u.public_id,
						display_name: u.display_name,
						username: u.username,
						email: u.email,
						status: u.status,
						email_verified_at: u.email_verified_at,
						banned_until: u.banned_until,
						deletion_due_at: u.deletion_due_at,
						created_at: u.created_at,
						last_active_ms: this.lastActive,
						role_count: this.roleCount,
					})
					.from(u)
					.where(where)
					.orderBy(...orderBy)
					.limit(limit)
					.offset(offset)
					.all(),
			count: (cap) =>
				this.db
					.select({ one: sql`1` })
					.from(u)
					.where(where)
					.limit(cap)
					.all().length,
		})
	}

	findByPublicId(publicId: string): (UserRow & { last_active_ms: number | null }) | undefined {
		const row = this.db
			.select({ user: usersTable, last_active_ms: this.lastActive })
			.from(usersTable)
			.where(and(eq(usersTable.public_id, publicId), ne(usersTable.status, "deleted")))
			.get()
		return row ? { ...row.user, last_active_ms: row.last_active_ms } : undefined
	}

	assignments(userId: number): AssignmentRow[] {
		return this.db
			.select({
				role_id: rolesTable.id,
				role_key: rolesTable.key,
				role_name: rolesTable.name,
				role_level: rolesTable.level,
				network_id: userRolesTable.network_id,
				granted_at: userRolesTable.granted_at,
				granted_by: userRolesTable.granted_by,
			})
			.from(userRolesTable)
			.innerJoin(rolesTable, eq(rolesTable.id, userRolesTable.role_id))
			.where(and(eq(userRolesTable.user_id, userId), isNull(userRolesTable.revoked_at)))
			.orderBy(sql`${userRolesTable.network_id} is not null`, desc(rolesTable.level))
			.all()
	}

	latestBan(userId: number): ModerationActionRow | undefined {
		return this.db
			.select()
			.from(moderationActionsTable)
			.where(
				and(
					eq(moderationActionsTable.target_user_id, userId),
					eq(moderationActionsTable.action, "ban"),
				),
			)
			.orderBy(desc(moderationActionsTable.created_at), desc(moderationActionsTable.id))
			.get()
	}

	// Sessions and refresh families

	liveSessions(userId: number, now: Date): SessionRow[] {
		return this.db
			.select()
			.from(sessionsTable)
			.where(
				and(
					eq(sessionsTable.user_id, userId),
					isNull(sessionsTable.revoked_at),
					gt(sessionsTable.expires_at, now),
					gt(sessionsTable.absolute_expires_at, now),
				),
			)
			.orderBy(desc(sessionsTable.last_seen_at))
			.all()
	}

	/** Usable refresh tokens (family heads), one per live family. */
	liveFamilyHeads(userId: number, now: Date): RefreshTokenRow[] {
		return this.db
			.select()
			.from(refreshTokensTable)
			.where(
				and(
					eq(refreshTokensTable.user_id, userId),
					isNull(refreshTokensTable.revoked_at),
					isNull(refreshTokensTable.replaced_by),
					gt(refreshTokensTable.expires_at, now),
				),
			)
			.all()
	}

	/** When each family started (its first token). */
	familyStarts(familyIds: string[]): Map<string, Date> {
		if (familyIds.length === 0) return new Map()
		const rows = this.db
			.select({
				family_id: refreshTokensTable.family_id,
				started: sql<number>`min(${refreshTokensTable.created_at})`,
			})
			.from(refreshTokensTable)
			.where(inArray(refreshTokensTable.family_id, familyIds))
			.groupBy(refreshTokensTable.family_id)
			.all()
		return new Map(rows.map((row) => [row.family_id, new Date(row.started)]))
	}

	sessionsByIds(ids: string[]): SessionRow[] {
		if (ids.length === 0) return []
		return this.db.select().from(sessionsTable).where(inArray(sessionsTable.id, ids)).all()
	}

	/** Revokes live refresh families of a user, all or the given ones; returns the families. */
	revokeFamilies(userId: number, now: Date, familyIds?: string[]): string[] {
		const rows = this.db
			.update(refreshTokensTable)
			.set({ revoked_at: now, revoke_reason: "admin_revoked" })
			.where(
				and(
					eq(refreshTokensTable.user_id, userId),
					isNull(refreshTokensTable.revoked_at),
					...(familyIds ? [inArray(refreshTokensTable.family_id, familyIds)] : []),
				),
			)
			.returning({ family_id: refreshTokensTable.family_id })
			.all()
		return [...new Set(rows.map((row) => row.family_id))]
	}

	/** Live families issued under a session (they end with it). */
	liveFamiliesOfSession(sessionId: string): string[] {
		return this.db
			.selectDistinct({ family_id: refreshTokensTable.family_id })
			.from(refreshTokensTable)
			.where(
				and(
					eq(refreshTokensTable.session_id, sessionId),
					isNull(refreshTokensTable.revoked_at),
				),
			)
			.all()
			.map((row) => row.family_id)
	}

	findLiveSession(userId: number, sessionId: string): SessionRow | undefined {
		return this.db
			.select()
			.from(sessionsTable)
			.where(
				and(
					eq(sessionsTable.id, sessionId),
					eq(sessionsTable.user_id, userId),
					isNull(sessionsTable.revoked_at),
				),
			)
			.get()
	}

	searchCandidates(q: string, exactEmail: boolean, limit: number): UserListRow[] {
		const pattern = escapeLike(q.toLowerCase())
		const matches: SQL[] = [
			sql`lower(${usersTable.username}) like ${`${pattern}%`} escape '\\'`,
			sql`lower(${usersTable.display_name}) like ${`${pattern}%`} escape '\\'`,
			eq(usersTable.public_id, q),
		]
		if (exactEmail) matches.push(eq(usersTable.email, q.toLowerCase()))
		return this.db
			.select({
				id: usersTable.id,
				public_id: usersTable.public_id,
				display_name: usersTable.display_name,
				username: usersTable.username,
				email: usersTable.email,
				status: usersTable.status,
				email_verified_at: usersTable.email_verified_at,
				banned_until: usersTable.banned_until,
				deletion_due_at: usersTable.deletion_due_at,
				created_at: usersTable.created_at,
				last_active_ms: this.lastActive,
				role_count: this.roleCount,
			})
			.from(usersTable)
			.where(and(eq(usersTable.status, "active"), or(...matches)))
			.orderBy(sql`lower(${usersTable.display_name})`)
			.limit(limit)
			.all()
	}
}
