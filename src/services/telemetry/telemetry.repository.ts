// telemetry.repository.ts

import { Injectable } from "@nestjs/common"
import { sql } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import { telemetryCountersTable } from "@schemas/core"

export interface CounterBatch {
	day: string
	platform: "ios" | "android"
	app_version: string
	city_slug: string
	counters: [string, number][]
}

@Injectable()
export class TelemetryRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	/** Adds each count to the day's aggregate row. */
	add(batch: CounterBatch): void {
		if (!batch.counters.length) return
		this.db.transaction((tx) => {
			for (const [key, count] of batch.counters) {
				tx.insert(telemetryCountersTable)
					.values({
						day: batch.day,
						platform: batch.platform,
						app_version: batch.app_version,
						city_slug: batch.city_slug,
						key,
						count,
					})
					.onConflictDoUpdate({
						target: [
							telemetryCountersTable.day,
							telemetryCountersTable.platform,
							telemetryCountersTable.app_version,
							telemetryCountersTable.city_slug,
							telemetryCountersTable.key,
						],
						set: { count: sql`${telemetryCountersTable.count} + ${count}` },
					})
					.run()
			}
		})
	}

	/** Totals per key for a day (tests and future dashboards). */
	totals(day: string): Record<string, number> {
		const rows = this.db
			.select({
				key: telemetryCountersTable.key,
				count: sql<number>`sum(${telemetryCountersTable.count})`,
			})
			.from(telemetryCountersTable)
			.where(sql`${telemetryCountersTable.day} = ${day}`)
			.groupBy(telemetryCountersTable.key)
			.all()
		return Object.fromEntries(rows.map((r) => [r.key, Number(r.count)]))
	}
}
