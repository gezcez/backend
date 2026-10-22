// account.repository.ts
// Users and email-code flows.

import { Injectable } from "@nestjs/common"
import { and, desc, eq, isNull, lt, lte, sql } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import {
	emailCodesTable,
	moderationActionsTable,
	statusAfterBan,
	usersTable,
	type EmailCodeRow,
	type ModerationActionRow,
	type NewUserRow,
	type UserRow,
} from "@schemas/core"

export type { EmailCodeRow, UserRow }
export type NewFlow = Omit<
	EmailCodeRow,
	"id" | "attempts" | "max_attempts" | "sends" | "consumed_at"
>

@Injectable()
export class AccountRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	findUserByEmail(email: string): UserRow | undefined {
		return this.db.select().from(usersTable).where(eq(usersTable.email, email)).get()
	}

	findUserById(id: number): UserRow | undefined {
		return this.db.select().from(usersTable).where(eq(usersTable.id, id)).get()
	}

	findUserByPublicId(publicId: string): UserRow | undefined {
		return this.db.select().from(usersTable).where(eq(usersTable.public_id, publicId)).get()
	}

	insertUser(row: NewUserRow): UserRow {
		return this.db.insert(usersTable).values(row).returning().get()
	}

	updateUser(id: number, values: Partial<NewUserRow>): UserRow | undefined {
		return this.db
			.update(usersTable)
			.set({ ...values, updated_at: new Date() })
			.where(eq(usersTable.id, id))
			.returning()
			.get()
	}

	/** Lifts a ban that has run out; returns the user as it is now (lifted or not). */
	liftExpiredBan(id: number, now: Date): UserRow | undefined {
		const lifted = this.db
			.update(usersTable)
			.set({ status: statusAfterBan, banned_until: null, updated_at: now })
			.where(
				and(
					eq(usersTable.id, id),
					eq(usersTable.status, "banned"),
					lte(usersTable.banned_until, now),
				),
			)
			.returning()
			.get()
		return lifted ?? this.findUserById(id)
	}

	setLastLogin(id: number, at: Date): void {
		this.db.update(usersTable).set({ last_login_at: at }).where(eq(usersTable.id, id)).run()
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
			.orderBy(desc(moderationActionsTable.created_at))
			.get()
	}

	insertFlow(row: NewFlow): void {
		this.db.insert(emailCodesTable).values(row).run()
	}

	findFlow(flowId: string): EmailCodeRow | undefined {
		return this.db
			.select()
			.from(emailCodesTable)
			.where(eq(emailCodesTable.flow_id, flowId))
			.get()
	}

	resendFlow(
		flowId: string,
		values: Pick<EmailCodeRow, "code_hash" | "resend_available_at" | "expires_at">,
	): void {
		this.db
			.update(emailCodesTable)
			.set({ ...values, attempts: 0, sends: sql`${emailCodesTable.sends} + 1` })
			.where(eq(emailCodesTable.flow_id, flowId))
			.run()
	}

	/** Atomically counts a failed attempt; returns the new count, or undefined when exhausted. */
	incrementAttempts(flowId: string): number | undefined {
		return this.db
			.update(emailCodesTable)
			.set({ attempts: sql`${emailCodesTable.attempts} + 1` })
			.where(
				and(
					eq(emailCodesTable.flow_id, flowId),
					lt(emailCodesTable.attempts, emailCodesTable.max_attempts),
				),
			)
			.returning({ attempts: emailCodesTable.attempts })
			.get()?.attempts
	}

	/** Atomically consumes a flow; false when another request consumed it first. */
	consumeFlow(flowId: string, at: Date): boolean {
		return Boolean(
			this.db
				.update(emailCodesTable)
				.set({ consumed_at: at })
				.where(
					and(eq(emailCodesTable.flow_id, flowId), isNull(emailCodesTable.consumed_at)),
				)
				.returning({ id: emailCodesTable.id })
				.get(),
		)
	}

	/** Test hook and cleanup: move a flow's expiry. */
	setFlowExpiry(flowId: string, expiresAt: Date, resendAvailableAt?: Date): void {
		this.db
			.update(emailCodesTable)
			.set({
				expires_at: expiresAt,
				...(resendAvailableAt ? { resend_available_at: resendAvailableAt } : {}),
			})
			.where(eq(emailCodesTable.flow_id, flowId))
			.run()
	}
}
