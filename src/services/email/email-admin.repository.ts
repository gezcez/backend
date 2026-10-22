// email-admin.repository.ts
// Dashboard reads of the outbox and the suppression list (metadata only).

import { Injectable } from "@nestjs/common"
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm"
import type { Page, PageQuery } from "@common/response"
import { escapeLike } from "@common/utils"
import { InjectCoreDb, paginate, type CoreDatabase } from "@db"
import {
	emailSuppressionsTable,
	emailsTable,
	type EmailRow,
	type EmailStatus,
	type EmailSuppressionRow,
	usersTable,
} from "@schemas/core"

export interface DeliveryFilter {
	status?: EmailStatus
	template?: string
	userId?: number
}

@Injectable()
export class EmailAdminRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	deliveries(filter: DeliveryFilter, query: PageQuery): Page<EmailRow> {
		const e = emailsTable
		const conditions: SQL[] = []
		if (filter.status) conditions.push(eq(e.status, filter.status))
		if (filter.template) conditions.push(eq(e.template, filter.template))
		if (filter.userId !== undefined) conditions.push(eq(e.user_id, filter.userId))
		if (query.q) {
			const pattern = `%${escapeLike(query.q)}%`
			conditions.push(
				or(
					eq(e.id, query.q),
					sql`${e.subject} like ${pattern} escape '\\'`,
					sql`${e.template} like ${`${escapeLike(query.q)}%`} escape '\\'`,
				)!,
			)
		}
		const where = conditions.length ? and(...conditions) : undefined
		const updated = sql`coalesce(${e.updated_at}, ${e.sent_at}, ${e.created_at})`
		return paginate({
			query,
			filters: { ...filter },
			sortable: { created_at: e.created_at, updated_at: updated },
			defaultSort: "created_at:desc",
			tieBreaker: e.id,
			fetch: (orderBy, limit, offset) =>
				this.db
					.select()
					.from(e)
					.where(where)
					.orderBy(...orderBy)
					.limit(limit)
					.offset(offset)
					.all(),
			count: (cap) =>
				this.db.select({ id: e.id }).from(e).where(where).limit(cap).all().length,
		})
	}

	suppressions(
		filter: { reason?: EmailSuppressionRow["reason"] },
		query: PageQuery,
	): Page<EmailSuppressionRow> {
		const s = emailSuppressionsTable
		const conditions: SQL[] = [isNull(s.removed_at)]
		if (filter.reason) conditions.push(eq(s.reason, filter.reason))
		if (query.q)
			conditions.push(sql`${s.email_masked} like ${`%${escapeLike(query.q)}%`} escape '\\'`)
		const where = and(...conditions)
		return paginate({
			query,
			filters: { ...filter },
			sortable: { created_at: s.created_at },
			defaultSort: "created_at:desc",
			tieBreaker: s.email_hash,
			fetch: (orderBy, limit, offset) =>
				this.db
					.select()
					.from(s)
					.where(where)
					.orderBy(...orderBy)
					.limit(limit)
					.offset(offset)
					.all(),
			count: (cap) =>
				this.db.select({ id: s.email_hash }).from(s).where(where).limit(cap).all().length,
		})
	}

	findActiveSuppression(id: string): EmailSuppressionRow | undefined {
		return this.db
			.select()
			.from(emailSuppressionsTable)
			.where(
				and(
					eq(emailSuppressionsTable.email_hash, id),
					isNull(emailSuppressionsTable.removed_at),
				),
			)
			.get()
	}

	removeSuppression(id: string, by: number, reason: string, now: Date): boolean {
		return (
			this.db
				.update(emailSuppressionsTable)
				.set({ removed_at: now, removed_by: by, removed_reason: reason })
				.where(
					and(
						eq(emailSuppressionsTable.email_hash, id),
						isNull(emailSuppressionsTable.removed_at),
					),
				)
				.returning()
				.all().length > 0
		)
	}

	userEmail(userId: number): string | undefined {
		return this.db
			.select({ email: usersTable.email })
			.from(usersTable)
			.where(eq(usersTable.id, userId))
			.get()?.email
	}

	/** Adds or re-activates a suppression (SES events and tests). */
	suppress(row: {
		email_hash: string
		email_masked: string
		reason: EmailSuppressionRow["reason"]
		detail: string | null
		now: Date
	}): void {
		const values = {
			email_hash: row.email_hash,
			email_masked: row.email_masked,
			reason: row.reason,
			detail: row.detail,
			created_at: row.now,
			removed_at: null,
			removed_by: null,
			removed_reason: null,
		}
		this.db
			.insert(emailSuppressionsTable)
			.values(values)
			.onConflictDoUpdate({ target: emailSuppressionsTable.email_hash, set: values })
			.run()
	}
}
