// app-config.repository.ts
// Reads the `app.*` flags from core.db for /v1/app/config. Definitions, validation and
// dashboard edits live in FlagsService (src/services/flags), which also drops this cache.

import { Injectable } from "@nestjs/common"
import { like } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import { flagsTable } from "@schemas/core"

@Injectable()
export class AppConfigRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	appFlags(): Map<string, unknown> {
		const rows = this.db
			.select({ key: flagsTable.key, value: flagsTable.value })
			.from(flagsTable)
			.where(like(flagsTable.key, "app.%"))
			.all()
		return new Map(rows.map((r) => [r.key, r.value]))
	}

	/** Writes one flag (tests and the dashboard until the flags service exists). */
	set(key: string, value: unknown, userId: number | null = null): void {
		this.db
			.insert(flagsTable)
			.values({ key, value, updated_by: userId, updated_at: new Date() })
			.onConflictDoUpdate({
				target: flagsTable.key,
				set: { value, updated_by: userId, updated_at: new Date() },
			})
			.run()
	}
}
