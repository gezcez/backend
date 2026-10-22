// _audit.ts
// Audit columns shared by admin-edited tables (was core TABLE_ACTIONS in legacy).

import { int } from "drizzle-orm/sqlite-core"

export function auditColumns() {
	return {
		created_at: int({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		created_by: int(),
		updated_at: int({ mode: "timestamp_ms" }),
		updated_by: int(),
		deleted_at: int({ mode: "timestamp_ms" }),
	}
}
