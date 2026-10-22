// self-service.repository.ts
// Reads and writes behind the account pages: authorized apps (grants and live refresh
// families), apps per session, and the user's recent security events.

import { Injectable } from "@nestjs/common"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import {
	appsTable,
	auditLogTable,
	grantsTable,
	refreshTokensTable,
	sessionsTable,
	type AppRow,
	type AuditLogRow,
	type GrantRow,
	type SessionRow,
} from "@schemas/core"

export interface LiveRefresh {
	session_id: string
	client_id: string
	created_at: Date
	last_used_at: Date | null
}

@Injectable()
export class SelfServiceRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	/** Refresh tokens that can still be used (family heads, not revoked). */
	liveRefreshForUser(userId: number): LiveRefresh[] {
		return this.db
			.select({
				session_id: refreshTokensTable.session_id,
				client_id: refreshTokensTable.client_id,
				created_at: refreshTokensTable.created_at,
				last_used_at: refreshTokensTable.last_used_at,
			})
			.from(refreshTokensTable)
			.where(
				and(
					eq(refreshTokensTable.user_id, userId),
					isNull(refreshTokensTable.revoked_at),
					isNull(refreshTokensTable.replaced_by),
				),
			)
			.all()
	}

	activeGrants(userId: number): GrantRow[] {
		return this.db
			.select()
			.from(grantsTable)
			.where(and(eq(grantsTable.user_id, userId), isNull(grantsTable.revoked_at)))
			.all()
	}

	apps(clientIds: string[]): AppRow[] {
		if (clientIds.length === 0) return []
		return this.db.select().from(appsTable).where(inArray(appsTable.client_id, clientIds)).all()
	}

	/** Revokes the grant and every live refresh family of the user for that client. */
	revokeApp(userId: number, clientId: string, now: Date): { grant: boolean; tokens: number } {
		return this.db.transaction((tx) => {
			const grant = tx
				.update(grantsTable)
				.set({ revoked_at: now, updated_at: now })
				.where(
					and(
						eq(grantsTable.user_id, userId),
						eq(grantsTable.client_id, clientId),
						isNull(grantsTable.revoked_at),
					),
				)
				.returning({ client_id: grantsTable.client_id })
				.all()
			const tokens = tx
				.update(refreshTokensTable)
				.set({ revoked_at: now, revoke_reason: "app_revoked" })
				.where(
					and(
						eq(refreshTokensTable.user_id, userId),
						eq(refreshTokensTable.client_id, clientId),
						isNull(refreshTokensTable.revoked_at),
					),
				)
				.returning({ id: refreshTokensTable.id })
				.all()
			return { grant: grant.length > 0, tokens: tokens.length }
		})
	}

	/** Last `limit` events of the given kinds where the user acted, newest first. */
	securityEvents(userId: number, actions: string[], limit: number): AuditLogRow[] {
		return this.db
			.select()
			.from(auditLogTable)
			.where(
				and(
					eq(auditLogTable.actor_user_id, userId),
					inArray(auditLogTable.action, actions),
				),
			)
			.orderBy(desc(auditLogTable.at), desc(auditLogTable.id))
			.limit(limit)
			.all()
	}

	sessionsByIds(ids: string[]): SessionRow[] {
		if (ids.length === 0) return []
		return this.db.select().from(sessionsTable).where(inArray(sessionsTable.id, ids)).all()
	}
}
