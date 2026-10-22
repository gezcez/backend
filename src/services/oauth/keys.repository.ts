// keys.repository.ts

import { Injectable } from "@nestjs/common"
import { asc, eq, isNull, or, gt } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import { signingKeysTable, type SigningKeyRow } from "@schemas/core"

export type { SigningKeyRow }

@Injectable()
export class KeysRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	/** Keys that are not retired yet (including keys scheduled to activate later). */
	listUnretired(now: Date): SigningKeyRow[] {
		return this.db
			.select()
			.from(signingKeysTable)
			.where(
				or(isNull(signingKeysTable.retire_after), gt(signingKeysTable.retire_after, now)),
			)
			.orderBy(asc(signingKeysTable.active_from))
			.all()
	}

	insert(row: SigningKeyRow): void {
		this.db.insert(signingKeysTable).values(row).run()
	}

	scheduleRetirement(kid: string, retireAfter: Date): void {
		this.db
			.update(signingKeysTable)
			.set({ retire_after: retireAfter })
			.where(eq(signingKeysTable.kid, kid))
			.run()
	}
}
