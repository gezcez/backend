// telemetry.ts
// Aggregate app counters (plan 5.1, P4). No user, device or session id is stored or derived.

import { int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const telemetryCountersTable = sqliteTable(
	"telemetry_counters",
	{
		/** YYYY-MM-DD as reported by the app (its local day). */
		day: text().notNull(),
		platform: text().$type<"ios" | "android">().notNull(),
		app_version: text().notNull(),
		/** City slug, or "" when the app has no city yet. */
		city_slug: text().notNull(),
		key: text().notNull(),
		count: int().notNull(),
	},
	(t) => [primaryKey({ columns: [t.day, t.platform, t.app_version, t.city_slug, t.key] })],
)
