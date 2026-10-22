// oauth.repository.ts
// Clients, consent grants, authorization requests, authorization codes and refresh families.

import { Injectable } from "@nestjs/common"
import { and, eq, isNull, min } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import {
	appsTable,
	authRequestsTable,
	grantsTable,
	oauthCodesTable,
	refreshTokensTable,
	usersTable,
	type AppRow,
	type AuthRequestRow,
	type AuthRequestStatus,
	type GrantRow,
	type OAuthCodeRow,
	type RefreshRevokeReason,
	type RefreshTokenRow,
	type UserRow,
} from "@schemas/core"

export type { AppRow, AuthRequestRow, GrantRow, OAuthCodeRow, RefreshTokenRow }

export type TokenUser = Pick<UserRow, "id" | "public_id" | "status">

@Injectable()
export class OAuthRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	findApp(clientId: string): AppRow | undefined {
		return this.db.select().from(appsTable).where(eq(appsTable.client_id, clientId)).get()
	}

	findUser(id: number): TokenUser | undefined {
		return this.db
			.select({
				id: usersTable.id,
				public_id: usersTable.public_id,
				status: usersTable.status,
			})
			.from(usersTable)
			.where(eq(usersTable.id, id))
			.get()
	}

	findUserByPublicId(publicId: string): TokenUser | undefined {
		return this.db
			.select({
				id: usersTable.id,
				public_id: usersTable.public_id,
				status: usersTable.status,
			})
			.from(usersTable)
			.where(eq(usersTable.public_id, publicId))
			.get()
	}

	// Grants

	findGrant(userId: number, clientId: string): GrantRow | undefined {
		return this.db
			.select()
			.from(grantsTable)
			.where(and(eq(grantsTable.user_id, userId), eq(grantsTable.client_id, clientId)))
			.get()
	}

	upsertGrant(userId: number, clientId: string, scopes: string[], now: Date): void {
		this.db
			.insert(grantsTable)
			.values({
				user_id: userId,
				client_id: clientId,
				scopes,
				created_at: now,
				updated_at: now,
				revoked_at: null,
			})
			.onConflictDoUpdate({
				target: [grantsTable.user_id, grantsTable.client_id],
				set: { scopes, updated_at: now, revoked_at: null },
			})
			.run()
	}

	// Authorization requests

	insertRequest(row: AuthRequestRow): void {
		this.db.insert(authRequestsTable).values(row).run()
	}

	findRequest(id: string): AuthRequestRow | undefined {
		return this.db.select().from(authRequestsTable).where(eq(authRequestsTable.id, id)).get()
	}

	updateRequest(id: string, patch: Partial<Pick<AuthRequestRow, "session_id" | "status">>): void {
		this.db.update(authRequestsTable).set(patch).where(eq(authRequestsTable.id, id)).run()
	}

	/** Moves a pending request to a final status; false when another call got there first. */
	finishRequest(id: string, status: Exclude<AuthRequestStatus, "pending">): boolean {
		const result = this.db
			.update(authRequestsTable)
			.set({ status })
			.where(and(eq(authRequestsTable.id, id), eq(authRequestsTable.status, "pending")))
			.returning({ id: authRequestsTable.id })
			.all()
		return result.length > 0
	}

	// Authorization codes

	insertCode(row: OAuthCodeRow): void {
		this.db.insert(oauthCodesTable).values(row).run()
	}

	findCode(codeHash: string): OAuthCodeRow | undefined {
		return this.db
			.select()
			.from(oauthCodesTable)
			.where(eq(oauthCodesTable.code_hash, codeHash))
			.get()
	}

	/** Single use: true only for the call that consumed the code. */
	consumeCode(codeHash: string, now: Date): boolean {
		const result = this.db
			.update(oauthCodesTable)
			.set({ consumed_at: now })
			.where(
				and(eq(oauthCodesTable.code_hash, codeHash), isNull(oauthCodesTable.consumed_at)),
			)
			.returning({ code_hash: oauthCodesTable.code_hash })
			.all()
		return result.length > 0
	}

	setCodeFamily(codeHash: string, familyId: string): void {
		this.db
			.update(oauthCodesTable)
			.set({ family_id: familyId })
			.where(eq(oauthCodesTable.code_hash, codeHash))
			.run()
	}

	// Refresh tokens

	insertRefresh(row: RefreshTokenRow): void {
		this.db.insert(refreshTokensTable).values(row).run()
	}

	findRefreshByHash(tokenHash: string): RefreshTokenRow | undefined {
		return this.db
			.select()
			.from(refreshTokensTable)
			.where(eq(refreshTokensTable.token_hash, tokenHash))
			.get()
	}

	/** When the family's first token was issued (its age cap counts from here). */
	familyStartedAt(familyId: string): Date | undefined {
		return (
			this.db
				.select({ started: min(refreshTokensTable.created_at) })
				.from(refreshTokensTable)
				.where(eq(refreshTokensTable.family_id, familyId))
				.get()?.started ?? undefined
		)
	}

	findRefresh(id: string): RefreshTokenRow | undefined {
		return this.db.select().from(refreshTokensTable).where(eq(refreshTokensTable.id, id)).get()
	}

	/**
	 * Rotation in one transaction: marks `old` replaced (only if it still is the live head of its
	 * family) and inserts its successor. Returns false when `old` was rotated or revoked meanwhile.
	 */
	rotateRefresh(oldId: string, successor: RefreshTokenRow, now: Date): boolean {
		return this.db.transaction((tx) => {
			const result = tx
				.update(refreshTokensTable)
				.set({ replaced_by: successor.id, replaced_at: now, last_used_at: now })
				.where(
					and(
						eq(refreshTokensTable.id, oldId),
						isNull(refreshTokensTable.replaced_by),
						isNull(refreshTokensTable.revoked_at),
					),
				)
				.returning({ id: refreshTokensTable.id })
				.all()
			if (result.length === 0) return false
			tx.insert(refreshTokensTable).values(successor).run()
			return true
		})
	}

	revokeFamily(familyId: string, reason: RefreshRevokeReason, now: Date): number {
		return this.db
			.update(refreshTokensTable)
			.set({ revoked_at: now, revoke_reason: reason })
			.where(
				and(
					eq(refreshTokensTable.family_id, familyId),
					isNull(refreshTokensTable.revoked_at),
				),
			)
			.returning({ id: refreshTokensTable.id })
			.all().length
	}
}
