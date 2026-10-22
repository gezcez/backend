// permission-keys.ts
// The canonical permission keys (plan section 6.4.1). A key that is not here does not exist:
// the registry fails the boot if a decorator uses an unknown key, and openapi.json publishes the
// list as the PermissionKey enum.

import type { PermissionScope } from "@schemas/core/rbac"

interface PermissionDefinition {
	/** Where the key is meaningful; network keys held globally apply in every network. */
	scope: PermissionScope | "both"
	description: string
}

export const PERMISSIONS = {
	"system.health.read": {
		scope: "global",
		description: "Global overview, system health, health channel",
	},
	"system.config.read": {
		scope: "global",
		description: "Sanitised runtime config, permission cache stats",
	},
	"ops.logs": { scope: "global", description: "ops.logs WS channel" },
	"users.read": { scope: "global", description: "User search and detail (masked emails)" },
	"users.pii.read": {
		scope: "global",
		description: "Reveal emails (audited), search by exact email",
	},
	"users.sessions.revoke": {
		scope: "global",
		description: "List and revoke a user's sessions and refresh families",
	},
	"moderation.read": { scope: "global", description: "Moderation log" },
	"moderation.write": { scope: "global", description: "Ban, unban, warn, notes" },
	"roles.read": { scope: "global", description: "Roles, permission matrix" },
	"roles.write": { scope: "global", description: "Create and edit roles, role permission sets" },
	"roles.assign": { scope: "global", description: "Grant and revoke global roles" },
	"permissions.read": { scope: "global", description: "Permission keys and route registry" },
	"permissions.write": { scope: "global", description: "Delete orphaned keys" },
	"apps.read": { scope: "global", description: "OAuth clients" },
	"apps.write": { scope: "global", description: "Create and edit clients" },
	"apps.secrets.rotate": { scope: "global", description: "Rotate and revoke client secrets" },
	"networks.read.all": { scope: "global", description: "List every network in the switcher" },
	"catalog.admin": { scope: "global", description: "Create, edit, delete cities and networks" },
	"providers.read": { scope: "global", description: "Providers, adapters, config schemas" },
	"providers.kill": { scope: "global", description: "Provider kill switch" },
	"archive.read": { scope: "global", description: "Archive manifest and upload status" },
	"archive.write": { scope: "global", description: "Re-run an export" },
	"email.read": { scope: "global", description: "Templates, previews, deliveries, suppressions" },
	"email.test.send": { scope: "global", description: "Test email to the caller's own address" },
	"email.test.send.any": { scope: "global", description: "Test email to any address (audited)" },
	"settings.read": { scope: "global", description: "Settings and flags pages" },
	"settings.write": { scope: "global", description: "Edit settings" },
	"flags.write": {
		scope: "both",
		description: "Toggle flags; network holders edit that network's override",
	},
	"jobs.read": { scope: "global", description: "Scheduled jobs and run history" },
	"jobs.run": { scope: "global", description: "Run a job now" },
	"audit.read": {
		scope: "both",
		description: "Audit log (network holders see that network only)",
	},
	"network.overview.read": { scope: "network", description: "Network overview" },
	"vehicles.live.read": {
		scope: "network",
		description: "Live map, full vehicle detail, 1 h trail",
	},
	"vehicles.history.read": { scope: "network", description: "Playback beyond 1 h" },
	"tracker.read": { scope: "network", description: "Tracker status, polls, stats, token status" },
	"tracker.control": {
		scope: "network",
		description: "Pause, resume, poll now, refresh token, clear fallback",
	},
	"tracker.config.write": {
		scope: "network",
		description: "Binding poll intervals, filter rules, dedup settings",
	},
	"catalog.read": {
		scope: "network",
		description: "Network profile, bindings, routes, stops, issues, sync runs",
	},
	"catalog.write": {
		scope: "network",
		description: "Network profile, privacy data, bindings, issue status",
	},
	"catalog.sync": { scope: "network", description: "Trigger a static sync" },
	"analytics.read": { scope: "network", description: "All analytics metrics" },
	"analytics.export": { scope: "network", description: "CSV and Parquet exports" },
	"members.read": { scope: "network", description: "Users with roles in the network (masked)" },
	"members.roles.write": {
		scope: "network",
		description: "Grant and revoke network roles (level rules)",
	},
	"support.read": { scope: "global", description: "Reserved for the support inbox" },
	"support.reply": { scope: "global", description: "Reserved for the support inbox" },
} as const satisfies Record<string, PermissionDefinition>

export type PermissionKey = keyof typeof PERMISSIONS
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[]

export function isPermissionKey(value: string): value is PermissionKey {
	return value in PERMISSIONS
}

/** Stored scope of a key: keys usable at both levels are stored as network keys. */
export function storedScope(key: PermissionKey): PermissionScope {
	const scope = PERMISSIONS[key].scope
	return scope === "both" ? "network" : scope
}

export type RoleKey = "root" | "admin" | "network_admin" | "moderator" | "analyst" | "viewer"

export interface RoleDefinition {
	key: RoleKey
	name: string
	description: string
	level: number
	immutable: boolean
	permissions: PermissionKey[]
}

const NETWORK_KEYS = PERMISSION_KEYS.filter((key) => PERMISSIONS[key].scope !== "global")

/** Default roles and grants (seeded; section 6.4.1). root bypasses checks and holds nothing. */
export const DEFAULT_ROLES: RoleDefinition[] = [
	{
		key: "root",
		name: "Root",
		description: "Bypasses permission checks (still audited)",
		level: 1000,
		immutable: true,
		permissions: [],
	},
	{
		key: "admin",
		name: "Admin",
		description: "Everything except deleting permission keys and provider kill switches",
		level: 900,
		immutable: false,
		permissions: PERMISSION_KEYS.filter(
			(key) => key !== "permissions.write" && key !== "providers.kill",
		),
	},
	{
		key: "network_admin",
		name: "Network admin",
		description: "All network permissions",
		level: 500,
		immutable: false,
		permissions: NETWORK_KEYS,
	},
	{
		key: "moderator",
		name: "Moderator",
		description: "User moderation",
		level: 300,
		immutable: false,
		permissions: ["users.read", "moderation.read", "moderation.write", "audit.read"],
	},
	{
		key: "analyst",
		name: "Analyst",
		description: "Read live data and analytics",
		level: 200,
		immutable: false,
		permissions: [
			"network.overview.read",
			"vehicles.live.read",
			"tracker.read",
			"catalog.read",
			"analytics.read",
			"analytics.export",
		],
	},
	{
		key: "viewer",
		name: "Viewer",
		description: "Read network overview, catalogue and analytics",
		level: 100,
		immutable: false,
		permissions: ["network.overview.read", "catalog.read", "analytics.read"],
	},
]
