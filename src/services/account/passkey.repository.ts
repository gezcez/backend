// passkey.repository.ts
// WebAuthn credentials and their single-use challenges.

import { Injectable } from "@nestjs/common"
import { and, asc, count, eq, gt, isNull, lt } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import {
	passkeysTable,
	webauthnChallengesTable,
	type NewPasskeyRow,
	type PasskeyRow,
	type WebauthnChallengeRow,
} from "@schemas/core"

export type { PasskeyRow, WebauthnChallengeRow }

/** Expired challenges older than this are deleted when new ones are made. */
const CHALLENGE_KEEP_MS = 3600_000

@Injectable()
export class PasskeyRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	listForUser(userId: number): PasskeyRow[] {
		return this.db
			.select()
			.from(passkeysTable)
			.where(eq(passkeysTable.user_id, userId))
			.orderBy(asc(passkeysTable.created_at), asc(passkeysTable.id))
			.all()
	}

	countForUser(userId: number): number {
		return (
			this.db
				.select({ n: count() })
				.from(passkeysTable)
				.where(eq(passkeysTable.user_id, userId))
				.get()?.n ?? 0
		)
	}

	findForUser(userId: number, id: string): PasskeyRow | undefined {
		return this.db
			.select()
			.from(passkeysTable)
			.where(and(eq(passkeysTable.id, id), eq(passkeysTable.user_id, userId)))
			.get()
	}

	findByCredentialId(credentialId: string): PasskeyRow | undefined {
		return this.db
			.select()
			.from(passkeysTable)
			.where(eq(passkeysTable.credential_id, credentialId))
			.get()
	}

	insert(row: NewPasskeyRow): PasskeyRow {
		return this.db.insert(passkeysTable).values(row).returning().get()
	}

	rename(id: string, name: string): PasskeyRow | undefined {
		return this.db
			.update(passkeysTable)
			.set({ name })
			.where(eq(passkeysTable.id, id))
			.returning()
			.get()
	}

	markUsed(id: string, signCount: number, backedUp: boolean, at: Date): void {
		this.db
			.update(passkeysTable)
			.set({ sign_count: signCount, backed_up: backedUp, last_used_at: at })
			.where(eq(passkeysTable.id, id))
			.run()
	}

	delete(id: string): void {
		this.db.delete(passkeysTable).where(eq(passkeysTable.id, id)).run()
	}

	insertChallenge(row: Omit<WebauthnChallengeRow, "consumed_at">): void {
		this.db.transaction((tx) => {
			tx.delete(webauthnChallengesTable)
				.where(
					lt(
						webauthnChallengesTable.expires_at,
						new Date(row.created_at.getTime() - CHALLENGE_KEEP_MS),
					),
				)
				.run()
			tx.insert(webauthnChallengesTable)
				.values({ ...row, consumed_at: null })
				.run()
		})
	}

	/** Marks a live challenge used and returns it; undefined when unknown, used or expired. */
	consumeChallenge(id: string, now: Date): WebauthnChallengeRow | undefined {
		return this.db
			.update(webauthnChallengesTable)
			.set({ consumed_at: now })
			.where(
				and(
					eq(webauthnChallengesTable.id, id),
					isNull(webauthnChallengesTable.consumed_at),
					gt(webauthnChallengesTable.expires_at, now),
				),
			)
			.returning()
			.get()
	}
}
