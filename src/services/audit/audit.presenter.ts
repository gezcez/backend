// audit.presenter.ts
// audit_log rows to AuditEntry: severity per action, before/after from the row's data with
// sensitive fields redacted, users shown by public id and name.

import type { AuditLogRow } from "@schemas/core"
import type { AuditEntry } from "./audit.dto"

const CRITICAL = new Set([
	"auth.refresh_reuse",
	"auth.code_replay",
	"apps.secret_rotated",
	"apps.secret_revoked",
	"apps.revoke_all",
	"apps.deleted",
	"permissions.deleted",
	"keys.rotated",
	"users.deleted",
	"flags.critical_updated",
	"settings.updated",
])
const WARN_PREFIXES = [
	"moderation.",
	"roles.",
	"users.sessions_revoked",
	"users.session_revoked",
	"users.email_revealed",
	"apps.",
	"flags.",
	"jobs.",
	"email.test_sent",
	"email.suppression_removed",
	"account.deletion",
	"auth.login_failed",
	"auth.password",
	"auth.email_changed",
]

export function auditSeverity(action: string): AuditEntry["severity"] {
	if (CRITICAL.has(action)) return "critical"
	return WARN_PREFIXES.some((prefix) => action.startsWith(prefix)) ? "warn" : "info"
}

const SENSITIVE = /(email|secret|token|password|code|ip|hash)/i

/** Replaces values under sensitive keys, at any depth. */
export function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact)
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [
				key,
				SENSITIVE.test(key) && inner !== null ? "[redacted]" : redact(inner),
			]),
		)
	}
	return value
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

export interface AuditLookups {
	users: Map<number, { id: string; display_name: string; username: string | null }>
	apps: Map<string, string>
	networks: Map<number, { name: string }>
	roles: Map<number, { name: string }>
}

export function presentAudit(row: AuditLogRow, lookups: AuditLookups): AuditEntry {
	const data = asRecord(row.data)
	const hasDiff = data !== null && ("before" in data || "after" in data)
	let targetId = row.target_id
	let label: string | null = null
	const numericTarget = row.target_id !== null ? Number(row.target_id) : NaN
	switch (row.target_type) {
		case "user": {
			const user = lookups.users.get(numericTarget)
			targetId = user?.id ?? (row.target_id?.startsWith("del_") ? row.target_id : null)
			label = user?.display_name ?? null
			break
		}
		case "app":
			label = (row.target_id && lookups.apps.get(row.target_id)) ?? null
			break
		case "network":
			label = lookups.networks.get(numericTarget)?.name ?? null
			break
		case "role":
			label = lookups.roles.get(numericTarget)?.name ?? null
			break
	}
	return {
		id: String(row.id),
		at: row.at.toISOString(),
		action: row.action,
		severity: auditSeverity(row.action),
		actor: row.actor_user_id !== null ? (lookups.users.get(row.actor_user_id) ?? null) : null,
		target_type: row.target_type,
		target_id: targetId,
		target_label: label,
		network_id: row.network_id,
		ip_prefix: null,
		request_id: row.request_id,
		before: hasDiff ? asRecord(redact(data.before)) : null,
		after: hasDiff ? asRecord(redact(data.after)) : data ? asRecord(redact(data)) : null,
	}
}
