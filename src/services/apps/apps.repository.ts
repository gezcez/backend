// apps.repository.ts
// OAuth client administration: CRUD, secret metadata, usage counts and revoke-all.

import { Injectable } from "@nestjs/common"
import { and, eq, gt, gte, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm"
import type { Page, PageQuery } from "@common/response"
import { InjectCoreDb, paginate, type CoreDatabase } from "@db"
import {
	appsTable,
	auditLogTable,
	grantsTable,
	refreshTokensTable,
	type AppRow,
} from "@schemas/core"

export type NewApp = typeof appsTable.$inferInsert

@Injectable()
export class AppsRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	page(query: PageQuery): Page<AppRow> {
		const conditions: SQL[] = []
		const q = query.q?.trim().toLowerCase()
		if (q) {
			const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
			conditions.push(
				sql`(lower(${appsTable.client_id}) like ${pattern} escape '\\' or lower(${appsTable.name}) like ${pattern} escape '\\')`,
			)
		}
		const where = conditions.length ? and(...conditions) : undefined
		const since = Date.now() - 86_400_000
		return paginate({
			query,
			filters: {},
			sortable: {
				name: sql`lower(${appsTable.name})`,
				created_at: appsTable.created_at,
				tokens_24h: sql`((select count(*) from audit_log a where a.action = 'auth.token_issued' and a.actor_client_id = "apps"."client_id" and a.at >= ${since}) + (select count(*) from refresh_tokens r where r.client_id = "apps"."client_id" and r.parent_id is not null and r.created_at >= ${since}))`,
			},
			defaultSort: "created_at:asc",
			tieBreaker: appsTable.id,
			fetch: (orderBy, limit, offset) =>
				this.db
					.select()
					.from(appsTable)
					.where(where)
					.orderBy(...orderBy)
					.limit(limit)
					.offset(offset)
					.all(),
			count: (cap) =>
				this.db
					.select({ one: sql`1` })
					.from(appsTable)
					.where(where)
					.limit(cap)
					.all().length,
		})
	}

	find(clientId: string): AppRow | undefined {
		return this.db.select().from(appsTable).where(eq(appsTable.client_id, clientId)).get()
	}

	insert(row: NewApp): AppRow {
		return this.db.insert(appsTable).values(row).returning().get()
	}

	update(clientId: string, patch: Partial<NewApp>): AppRow {
		return this.db
			.update(appsTable)
			.set(patch)
			.where(eq(appsTable.client_id, clientId))
			.returning()
			.get()
	}

	/** Deletes the client, its consent grants and its refresh tokens. */
	delete(clientId: string): void {
		this.db.transaction((tx) => {
			tx.delete(refreshTokensTable).where(eq(refreshTokensTable.client_id, clientId)).run()
			tx.delete(grantsTable).where(eq(grantsTable.client_id, clientId)).run()
			tx.delete(appsTable).where(eq(appsTable.client_id, clientId)).run()
		})
	}

	/** Live refresh families per client. */
	activeFamilies(clientIds: string[], now: Date): Map<string, number> {
		if (clientIds.length === 0) return new Map()
		const rows = this.db
			.select({
				client_id: refreshTokensTable.client_id,
				n: sql<number>`count(distinct ${refreshTokensTable.family_id})`,
			})
			.from(refreshTokensTable)
			.where(
				and(
					inArray(refreshTokensTable.client_id, clientIds),
					isNull(refreshTokensTable.revoked_at),
					isNull(refreshTokensTable.replaced_by),
					gt(refreshTokensTable.expires_at, now),
				),
			)
			.groupBy(refreshTokensTable.client_id)
			.all()
		return new Map(rows.map((row) => [row.client_id, row.n]))
	}

	/**
	 * Tokens issued per client and UTC day since `since`: authorization code exchanges (audited)
	 * plus refresh rotations.
	 */
	usage(clientIds: string[], since: Date): { client_id: string; day: string; n: number }[] {
		if (clientIds.length === 0) return []
		const day = (column: SQL | typeof auditLogTable.at) =>
			sql<string>`strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`
		const issued = this.db
			.select({
				client_id: sql<string>`${auditLogTable.actor_client_id}`,
				day: day(auditLogTable.at),
				n: sql<number>`count(*)`,
			})
			.from(auditLogTable)
			.where(
				and(
					eq(auditLogTable.action, "auth.token_issued"),
					inArray(auditLogTable.actor_client_id, clientIds),
					gte(auditLogTable.at, since),
				),
			)
			.groupBy(auditLogTable.actor_client_id, day(auditLogTable.at))
			.all()
		const rotated = this.db
			.select({
				client_id: refreshTokensTable.client_id,
				day: day(sql`${refreshTokensTable.created_at}`),
				n: sql<number>`count(*)`,
			})
			.from(refreshTokensTable)
			.where(
				and(
					inArray(refreshTokensTable.client_id, clientIds),
					isNotNull(refreshTokensTable.parent_id),
					gte(refreshTokensTable.created_at, since),
				),
			)
			.groupBy(refreshTokensTable.client_id, day(sql`${refreshTokensTable.created_at}`))
			.all()
		return [...issued, ...rotated]
	}

	/** Revokes every live refresh token of the client; returns the number of families ended. */
	revokeAll(clientId: string, now: Date): number {
		const rows = this.db
			.update(refreshTokensTable)
			.set({ revoked_at: now, revoke_reason: "app_revoked" })
			.where(
				and(
					eq(refreshTokensTable.client_id, clientId),
					isNull(refreshTokensTable.revoked_at),
				),
			)
			.returning({ family_id: refreshTokensTable.family_id })
			.all()
		return new Set(rows.map((row) => row.family_id)).size
	}
}
