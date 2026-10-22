// users.repository.ts

import { Injectable } from "@nestjs/common"
import { eq } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import { usersTable, type UserRow } from "@schemas/core"

export type { UserRow }

@Injectable()
export class UsersRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	findById(id: number): UserRow | undefined {
		return this.db.select().from(usersTable).where(eq(usersTable.id, id)).get()
	}

	updateProfile(
		id: number,
		patch: Partial<Pick<UserRow, "display_name" | "locale">>,
		now: Date,
	): UserRow {
		return this.db
			.update(usersTable)
			.set({ ...patch, updated_at: now })
			.where(eq(usersTable.id, id))
			.returning()
			.get()!
	}
}
