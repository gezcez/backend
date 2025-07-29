import {int} from "drizzle-orm/sqlite-core"
export const TABLE_ACTIONS = {
	created_by:int().notNull(),
	updated_by:int(),
	created_at:int({mode:"timestamp_ms"}).defaultNow(),
	updated_at:int({mode:"timestamp_ms"}),
}