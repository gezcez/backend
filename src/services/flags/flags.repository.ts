// flags.repository.ts

import { Injectable } from "@nestjs/common"
import { and, desc, eq, inArray } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import { auditLogTable, flagsTable, type AuditLogRow, type FlagRow } from "@schemas/core"

@Injectable()
export class FlagsRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	all(): FlagRow[] {
		return this.db.select().from(flagsTable).all()
	}

	upsert(key: string, value: unknown, userId: number | null, now: Date): void {
		this.db
			.insert(flagsTable)
			.values({ key, value, updated_by: userId, updated_at: now })
			.onConflictDoUpdate({
				target: flagsTable.key,
				set: { value, updated_by: userId, updated_at: now },
			})
			.run()
	}

	/** Back to the code default. */
	remove(key: string): void {
		this.db.delete(flagsTable).where(eq(flagsTable.key, key)).run()
	}

	/** Change history from the audit log, newest first. */
	history(key: string, actions: string[], limit: number): AuditLogRow[] {
		return this.db
			.select()
			.from(auditLogTable)
			.where(
				and(
					inArray(auditLogTable.action, actions),
					eq(auditLogTable.target_type, "flag"),
					eq(auditLogTable.target_id, key),
				),
			)
			.orderBy(desc(auditLogTable.id))
			.limit(limit)
			.all()
	}
}
