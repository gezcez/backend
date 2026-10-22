// audit.repository.ts

import { Injectable } from "@nestjs/common"
import { and, eq, gte, like, lte, or, sql, type SQL } from "drizzle-orm"
import type { Page, PageQuery } from "@common/response"
import { InjectCoreDb, paginate, type CoreDatabase } from "@db"
import { auditLogTable, type AuditLogRow } from "@schemas/core"

export interface AuditInsert {
	action: string
	actor_user_id?: number | null
	actor_client_id?: string | null
	target_type?: string | null
	target_id?: string | null
	network_id?: number | null
	request_id?: string | null
	ip_hash?: string | null
	data?: Record<string, unknown> | null
}

export interface AuditFilter {
	actorUserId?: number
	action?: string
	targetType?: string
	/** Matched as given, and also as an internal user id when `targetUserId` is set. */
	targetId?: string
	targetUserId?: number
	networkId?: number
	from?: Date
	to?: Date
	/** Rows where the user is the actor or the target. */
	involvingUserId?: number
}

@Injectable()
export class AuditRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	insert(row: AuditInsert): void {
		this.db
			.insert(auditLogTable)
			.values({ ...row, at: new Date() })
			.run()
	}

	page(filter: AuditFilter, query: PageQuery): Page<AuditLogRow> {
		const conditions: SQL[] = []
		const t = auditLogTable
		if (filter.actorUserId !== undefined)
			conditions.push(eq(t.actor_user_id, filter.actorUserId))
		if (filter.action) {
			conditions.push(
				filter.action.endsWith(".*")
					? like(t.action, `${filter.action.slice(0, -1).replace(/[%_]/g, "")}%`)
					: eq(t.action, filter.action),
			)
		}
		if (filter.targetType) conditions.push(eq(t.target_type, filter.targetType))
		if (filter.targetId !== undefined) {
			const asUser =
				filter.targetUserId !== undefined
					? and(eq(t.target_type, "user"), eq(t.target_id, String(filter.targetUserId)))
					: undefined
			conditions.push(
				asUser
					? or(eq(t.target_id, filter.targetId), asUser)!
					: eq(t.target_id, filter.targetId),
			)
		}
		if (filter.networkId !== undefined) conditions.push(eq(t.network_id, filter.networkId))
		if (filter.from) conditions.push(gte(t.at, filter.from))
		if (filter.to) conditions.push(lte(t.at, filter.to))
		if (filter.involvingUserId !== undefined) {
			conditions.push(
				or(
					eq(t.actor_user_id, filter.involvingUserId),
					and(eq(t.target_type, "user"), eq(t.target_id, String(filter.involvingUserId))),
				)!,
			)
		}
		const where = conditions.length ? and(...conditions) : undefined
		return paginate({
			query,
			filters: { ...filter },
			sortable: { at: t.at },
			defaultSort: "at:desc",
			tieBreaker: t.id,
			fetch: (orderBy, limit, offset) =>
				this.db
					.select()
					.from(t)
					.where(where)
					.orderBy(...orderBy)
					.limit(limit)
					.offset(offset)
					.all(),
			count: (cap) =>
				this.db
					.select({ one: sql`1` })
					.from(t)
					.where(where)
					.limit(cap)
					.all().length,
		})
	}

	/**
	 * Account deletion: the user's audit rows stay, pointing at a tombstone id instead of the user.
	 * Returns the number of rows changed.
	 */
	anonymiseUser(userId: number, tombstone: string): number {
		const asActor = this.db
			.update(auditLogTable)
			.set({
				actor_user_id: null,
				data: sql`json_set(coalesce(${auditLogTable.data}, '{}'), '$.actor_tombstone', ${tombstone})`,
			})
			.where(eq(auditLogTable.actor_user_id, userId))
			.returning({ id: auditLogTable.id })
			.all().length
		const asTarget = this.db
			.update(auditLogTable)
			.set({ target_id: tombstone })
			.where(
				and(
					eq(auditLogTable.target_type, "user"),
					eq(auditLogTable.target_id, String(userId)),
				),
			)
			.returning({ id: auditLogTable.id })
			.all().length
		return asActor + asTarget
	}
}
