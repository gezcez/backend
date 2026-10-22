// session.repository.ts
// Identity sessions. Revoking a session also revokes the refresh families issued under it.

import { Injectable } from "@nestjs/common"
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import {
	refreshTokensTable,
	sessionsTable,
	usersTable,
	type RefreshRevokeReason,
	type SessionRevokeReason,
	type SessionRow,
	type UserRow,
} from "@schemas/core"

export type { SessionRow, SessionRevokeReason }

export type SessionWithUser = SessionRow & {
	user: Pick<
		UserRow,
		"id" | "public_id" | "status" | "display_name" | "email" | "locale" | "banned_until"
	>
}

const userColumns = {
	id: usersTable.id,
	public_id: usersTable.public_id,
	status: usersTable.status,
	display_name: usersTable.display_name,
	email: usersTable.email,
	locale: usersTable.locale,
	banned_until: usersTable.banned_until,
}

function refreshReason(reason: SessionRevokeReason): RefreshRevokeReason {
	switch (reason) {
		case "logout":
		case "logout_device":
			return "logout"
		case "ban":
			return "ban"
		case "reuse_detected":
			return "reuse_detected"
		case "password_reset":
			return "password_reset"
		default:
			return "session_revoked"
	}
}

@Injectable()
export class SessionRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	insert(row: SessionRow): void {
		this.db.insert(sessionsTable).values(row).run()
	}

	findByTokenHash(tokenHash: string): SessionWithUser | undefined {
		const row = this.db
			.select({ session: sessionsTable, user: userColumns })
			.from(sessionsTable)
			.innerJoin(usersTable, eq(usersTable.id, sessionsTable.user_id))
			.where(eq(sessionsTable.token_hash, tokenHash))
			.get()
		return row ? { ...row.session, user: row.user } : undefined
	}

	findById(id: string): SessionWithUser | undefined {
		const row = this.db
			.select({ session: sessionsTable, user: userColumns })
			.from(sessionsTable)
			.innerJoin(usersTable, eq(usersTable.id, sessionsTable.user_id))
			.where(eq(sessionsTable.id, id))
			.get()
		return row ? { ...row.session, user: row.user } : undefined
	}

	/** Every session ever created on this device, newest first, with its user. */
	listByDevice(deviceHash: string): SessionWithUser[] {
		return this.db
			.select({ session: sessionsTable, user: userColumns })
			.from(sessionsTable)
			.innerJoin(usersTable, eq(usersTable.id, sessionsTable.user_id))
			.where(eq(sessionsTable.device_id_hash, deviceHash))
			.orderBy(desc(sessionsTable.created_at))
			.all()
			.map((row) => ({ ...row.session, user: row.user }))
	}

	listLiveForUser(userId: number, now: Date): SessionRow[] {
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
			.all()
	}

	touch(id: string, lastSeenAt: Date, expiresAt: Date): void {
		this.db
			.update(sessionsTable)
			.set({ last_seen_at: lastSeenAt, expires_at: expiresAt })
			.where(eq(sessionsTable.id, id))
			.run()
	}

	updateAuth(id: string, authTime: Date, amr: SessionRow["amr"]): void {
		this.db
			.update(sessionsTable)
			.set({ auth_time: authTime, amr })
			.where(eq(sessionsTable.id, id))
			.run()
	}

	replaceToken(id: string, tokenHash: string, now: Date): void {
		this.db
			.update(sessionsTable)
			.set({ token_hash: tokenHash, last_seen_at: now, signed_out_at: null })
			.where(eq(sessionsTable.id, id))
			.run()
	}

	/**
	 * Revokes sessions and every unrevoked refresh token issued under them, in one transaction.
	 * `signedOut` keeps the rows visible as "signed out" in the device account chooser.
	 */
	revoke(ids: string[], reason: SessionRevokeReason, now: Date, signedOut: boolean): string[] {
		if (ids.length === 0) return []
		return this.db.transaction((tx) => {
			const revoked = tx
				.update(sessionsTable)
				.set({
					revoked_at: now,
					revoke_reason: reason,
					...(signedOut ? { signed_out_at: now } : {}),
				})
				.where(and(inArray(sessionsTable.id, ids), isNull(sessionsTable.revoked_at)))
				.returning({ id: sessionsTable.id })
				.all()
				.map((row) => row.id)
			tx.update(refreshTokensTable)
				.set({ revoked_at: now, revoke_reason: refreshReason(reason) })
				.where(
					and(
						inArray(refreshTokensTable.session_id, ids),
						isNull(refreshTokensTable.revoked_at),
					),
				)
				.run()
			return revoked
		})
	}

	/** Live sessions of a user on one device, except `exceptId` (used when signing in again). */
	liveIdsForUserOnDevice(userId: number, deviceHash: string, exceptId: string): string[] {
		return this.db
			.select({ id: sessionsTable.id })
			.from(sessionsTable)
			.where(
				and(
					eq(sessionsTable.user_id, userId),
					eq(sessionsTable.device_id_hash, deviceHash),
					isNull(sessionsTable.revoked_at),
					ne(sessionsTable.id, exceptId),
				),
			)
			.all()
			.map((row) => row.id)
	}

	liveIdsForDevice(deviceHash: string): string[] {
		return this.db
			.select({ id: sessionsTable.id })
			.from(sessionsTable)
			.where(
				and(eq(sessionsTable.device_id_hash, deviceHash), isNull(sessionsTable.revoked_at)),
			)
			.all()
			.map((row) => row.id)
	}

	liveIdsForUser(userId: number): string[] {
		return this.db
			.select({ id: sessionsTable.id })
			.from(sessionsTable)
			.where(and(eq(sessionsTable.user_id, userId), isNull(sessionsTable.revoked_at)))
			.all()
			.map((row) => row.id)
	}

	revokedSince(since: Date): { id: string; revoked_at: Date }[] {
		return this.db
			.select({ id: sessionsTable.id, revoked_at: sessionsTable.revoked_at })
			.from(sessionsTable)
			.where(and(isNotNull(sessionsTable.revoked_at), gt(sessionsTable.revoked_at, since)))
			.all() as { id: string; revoked_at: Date }[]
	}
}
