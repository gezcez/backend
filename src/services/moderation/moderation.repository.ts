// moderation.repository.ts

import { Injectable } from "@nestjs/common"
import { and, eq, sql, type SQL } from "drizzle-orm"
import type { Page, PageQuery } from "@common/response"
import { InjectCoreDb, paginate, type CoreDatabase } from "@db"
import { moderationActionsTable, usersTable, type ModerationActionRow } from "@schemas/core"

export interface ModerationFilter {
	action?: ModerationActionRow["action"]
	active?: boolean
	targetUserId?: number
}

export type ModerationListRow = ModerationActionRow & { active: number }

@Injectable()
export class ModerationRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	/**
	 * A ban is active while it is the user's latest ban, the user is still banned and the ban has
	 * not run out. Tables are named explicitly in the correlated subquery.
	 */
	private active(now: number) {
		return sql<number>`(case when "moderation_actions"."action" = 'ban'
		and "users"."status" = 'banned'
		and ("users"."banned_until" is null or "users"."banned_until" > ${now})
		and "moderation_actions"."id" = (select max(m2.id) from moderation_actions m2 where m2.target_user_id = "moderation_actions"."target_user_id" and m2.action = 'ban')
		then 1 else 0 end)`
	}

	ban(input: {
		userId: number
		by: number
		publicReason: string
		privateReason: string | null
		until: Date | null
		now: Date
	}): ModerationActionRow {
		return this.db.transaction((tx) => {
			tx.update(usersTable)
				.set({ status: "banned", banned_until: input.until, updated_at: input.now })
				.where(eq(usersTable.id, input.userId))
				.run()
			return tx
				.insert(moderationActionsTable)
				.values({
					target_user_id: input.userId,
					action: "ban",
					public_reason: input.publicReason,
					private_reason: input.privateReason,
					expires_at: input.until,
					created_by: input.by,
					created_at: input.now,
				})
				.returning()
				.get()
		})
	}

	unban(input: { userId: number; by: number; reason: string; now: Date }): void {
		this.db.transaction((tx) => {
			tx.update(usersTable)
				.set({ status: "active", banned_until: null, updated_at: input.now })
				.where(eq(usersTable.id, input.userId))
				.run()
			tx.insert(moderationActionsTable)
				.values({
					target_user_id: input.userId,
					action: "unban",
					public_reason: input.reason,
					created_by: input.by,
					created_at: input.now,
				})
				.run()
		})
	}

	page(filter: ModerationFilter, query: PageQuery): Page<ModerationListRow> {
		const m = moderationActionsTable
		const active = this.active(Date.now())
		const conditions: SQL[] = []
		if (filter.action) conditions.push(eq(m.action, filter.action))
		if (filter.targetUserId !== undefined)
			conditions.push(eq(m.target_user_id, filter.targetUserId))
		if (filter.active !== undefined) conditions.push(sql`${active} = ${filter.active ? 1 : 0}`)
		const where = conditions.length ? and(...conditions) : undefined
		const base = () =>
			this.db
				.select({ row: m, active })
				.from(m)
				.innerJoin(usersTable, eq(usersTable.id, m.target_user_id))
		return paginate({
			query,
			filters: { ...filter },
			sortable: { at: m.created_at },
			defaultSort: "at:desc",
			tieBreaker: m.id,
			fetch: (orderBy, limit, offset) =>
				base()
					.where(where)
					.orderBy(...orderBy)
					.limit(limit)
					.offset(offset)
					.all()
					.map(({ row, active }) => ({ ...row, active })),
			count: (cap) => base().where(where).limit(cap).all().length,
		})
	}
}
