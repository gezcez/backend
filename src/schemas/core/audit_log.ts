// audit_log.ts
// Written explicitly by services through AuditService.record(), never guessed by an interceptor.

import { index, int, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const auditLogTable = sqliteTable(
	"audit_log",
	{
		id: int().primaryKey({ autoIncrement: true }),
		at: int({ mode: "timestamp_ms" }).notNull(),
		actor_user_id: int(),
		actor_client_id: text(),
		/** auth.login, auth.refresh_reuse, roles.grant, provider.kill, ... */
		action: text().notNull(),
		target_type: text(),
		target_id: text(),
		network_id: int(),
		request_id: text(),
		ip_hash: text(),
		data: text({ mode: "json" }).$type<Record<string, unknown>>(),
	},
	(t) => [
		index("audit_log_at_idx").on(t.at),
		index("audit_log_actor_idx").on(t.actor_user_id, t.at),
		index("audit_log_target_idx").on(t.target_type, t.target_id, t.at),
		index("audit_log_network_idx").on(t.network_id, t.at),
	],
)

export type AuditLogRow = typeof auditLogTable.$inferSelect
