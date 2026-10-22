// seed.ts
// Idempotent seed steps, shared by scripts/seed.ts and the NODE_ENV=test boot so the published
// image and the e2e suites run on the same rows (plan section 5.1).

import { and, eq, isNull, notInArray } from "drizzle-orm"
import type { AppConfig } from "@common/config"
import { DEFAULT_ROLES, PERMISSIONS, PERMISSION_KEYS, storedScope } from "@common/permission-keys"
import { newId } from "@common/utils"
import type { CoreDatabase } from "./database.module"
import {
	appsTable,
	type AppPlatform,
	citiesTable,
	networksTable,
	permissionsTable,
	rolePermissionsTable,
	rolesTable,
	userRolesTable,
	usersTable,
} from "@schemas/core"

export type SeedEnvironment = "production" | "staging" | "local" | "test"

export interface SeedContext {
	environment: SeedEnvironment
	config: AppConfig
	rootEmail?: string
}

export interface SeedStep {
	name: string
	/** Upserts rows and returns a short summary. Must be idempotent. */
	run(db: CoreDatabase, context: SeedContext): string
}

const FULL = ["openid", "profile", "email", "offline_access"]
const WEB_REFRESH_TTL = 2_592_000
const MOBILE_REFRESH_TTL = 7_776_000

interface SeedApp {
	client_id: string
	name: string
	platform: AppPlatform
	first_party: boolean
	system: boolean
	dev: boolean
	refresh_cookie: boolean
	redirect_uris: string[]
	post_logout_redirect_uris: string[]
	allowed_scopes: string[]
	refresh_ttl_s: number
	homepage_url?: string
	environments: SeedEnvironment[]
}

function dashboardUris(origin: string) {
	return {
		redirect_uris: [`${origin}/auth/callback`, `${origin}/auth/step-up`],
		post_logout_redirect_uris: [`${origin}/auth/logged-out`],
	}
}

/** The seeded clients, per environment (production and staging have separate databases). */
export function seedApps(environment: SeedEnvironment): SeedApp[] {
	const apps: SeedApp[] = [
		{
			client_id: "dashboard",
			name: "gezcez Dashboard",
			platform: "web",
			first_party: true,
			system: true,
			dev: false,
			refresh_cookie: true,
			...dashboardUris(
				environment === "production"
					? "https://dash.gezcez.com"
					: "https://dash-staging.gezcez.com",
			),
			allowed_scopes: [...FULL, "dash"],
			refresh_ttl_s: WEB_REFRESH_TTL,
			homepage_url: "https://dash.gezcez.com",
			environments: ["production", "staging"],
		},
		{
			client_id: "dashboard-dev",
			name: "gezcez Dashboard (dev)",
			platform: "dev",
			first_party: true,
			system: false,
			dev: true,
			refresh_cookie: true,
			...dashboardUris("http://localhost:5173"),
			allowed_scopes: [...FULL, "dash"],
			refresh_ttl_s: WEB_REFRESH_TTL,
			environments: ["staging", "local", "test"],
		},
		{
			client_id: "mobile",
			name: "gezcez",
			platform: "native",
			first_party: true,
			system: true,
			dev: false,
			refresh_cookie: false,
			redirect_uris: [
				environment === "production"
					? "gezcez://oauth/callback"
					: "gezcez-preview://oauth/callback",
			],
			post_logout_redirect_uris: [],
			allowed_scopes: [...FULL, "transit"],
			refresh_ttl_s: MOBILE_REFRESH_TTL,
			homepage_url: "https://gezcez.com",
			environments: ["production", "staging"],
		},
		{
			client_id: "mobile-dev",
			name: "gezcez (dev)",
			platform: "native",
			first_party: true,
			system: false,
			dev: true,
			refresh_cookie: false,
			redirect_uris: ["gezcez-dev://oauth/callback", "exp+gezcez-dev://oauth/callback"],
			post_logout_redirect_uris: [],
			allowed_scopes: [...FULL, "transit"],
			refresh_ttl_s: MOBILE_REFRESH_TTL,
			environments: ["staging", "local", "test"],
		},
		{
			client_id: "e2e_client",
			name: "E2E client",
			platform: "dev",
			first_party: true,
			system: false,
			dev: true,
			refresh_cookie: false,
			redirect_uris: ["http://localhost:4710/callback"],
			post_logout_redirect_uris: ["http://localhost:4710/"],
			allowed_scopes: FULL,
			refresh_ttl_s: WEB_REFRESH_TTL,
			environments: ["test"],
		},
		{
			client_id: "e2e_third_party",
			name: "E2E third party",
			platform: "dev",
			first_party: false,
			system: false,
			dev: true,
			refresh_cookie: false,
			redirect_uris: ["http://localhost:4710/callback"],
			post_logout_redirect_uris: ["http://localhost:4710/"],
			allowed_scopes: FULL,
			refresh_ttl_s: WEB_REFRESH_TTL,
			homepage_url: "http://localhost:4710/",
			environments: ["test"],
		},
	]
	return apps.filter((app) => app.environments.includes(environment))
}

const appsStep: SeedStep = {
	name: "apps",
	run(db, { environment }) {
		const now = new Date()
		const apps = seedApps(environment)
		for (const app of apps) {
			const { environments: _environments, ...row } = app
			db.insert(appsTable)
				.values({
					...row,
					type: "public",
					homepage_url: row.homepage_url ?? null,
					created_at: now,
				})
				.onConflictDoUpdate({
					target: appsTable.client_id,
					set: {
						name: row.name,
						platform: row.platform,
						first_party: row.first_party,
						system: row.system,
						dev: row.dev,
						refresh_cookie: row.refresh_cookie,
						redirect_uris: row.redirect_uris,
						post_logout_redirect_uris: row.post_logout_redirect_uris,
						allowed_scopes: row.allowed_scopes,
						refresh_ttl_s: row.refresh_ttl_s,
						updated_at: now,
					},
				})
				.run()
		}
		return apps.map((app) => app.client_id).join(", ")
	},
}

const permissionsStep: SeedStep = {
	name: "permissions",
	run(db) {
		const now = new Date()
		for (const key of PERMISSION_KEYS) {
			db.insert(permissionsTable)
				.values({
					key,
					scope: storedScope(key),
					description: PERMISSIONS[key].description,
					first_seen_at: now,
				})
				.onConflictDoUpdate({
					target: permissionsTable.key,
					set: {
						scope: storedScope(key),
						description: PERMISSIONS[key].description,
						orphaned_at: null,
					},
				})
				.run()
		}
		db.update(permissionsTable)
			.set({ orphaned_at: now })
			.where(
				and(
					notInArray(permissionsTable.key, PERMISSION_KEYS),
					isNull(permissionsTable.orphaned_at),
				),
			)
			.run()
		return `${PERMISSION_KEYS.length} keys`
	},
}

/**
 * Creates missing default roles with their default grants. Existing editable roles keep whatever
 * the dashboard changed; immutable roles are reset to their definition.
 */
const rolesStep: SeedStep = {
	name: "roles",
	run(db) {
		const now = new Date()
		let created = 0
		for (const role of DEFAULT_ROLES) {
			const existing = db.select().from(rolesTable).where(eq(rolesTable.key, role.key)).get()
			if (existing && !existing.immutable) continue
			const id =
				existing?.id ??
				db
					.insert(rolesTable)
					.values({
						key: role.key,
						name: role.name,
						description: role.description,
						level: role.level,
						immutable: role.immutable,
						created_at: now,
					})
					.returning({ id: rolesTable.id })
					.get().id
			if (existing) {
				db.update(rolesTable)
					.set({
						name: role.name,
						description: role.description,
						level: role.level,
						updated_at: now,
					})
					.where(eq(rolesTable.id, id))
					.run()
				db.delete(rolePermissionsTable).where(eq(rolePermissionsTable.role_id, id)).run()
			} else {
				created++
			}
			for (const key of role.permissions) {
				db.insert(rolePermissionsTable)
					.values({ role_id: id, permission_key: key, created_at: now })
					.onConflictDoNothing()
					.run()
			}
		}
		return `${created} created`
	},
}

function ensureUser(db: CoreDatabase, email: string, displayName: string): number {
	const existing = db
		.select({ id: usersTable.id })
		.from(usersTable)
		.where(eq(usersTable.email, email))
		.get()
	if (existing) return existing.id
	const now = new Date()
	return db
		.insert(usersTable)
		.values({
			public_id: newId(),
			email,
			email_verified_at: now,
			display_name: displayName,
			locale: "en",
			terms_version: "seed",
			privacy_version: "seed",
			terms_accepted_at: now,
			created_at: now,
		})
		.returning({ id: usersTable.id })
		.get().id
}

function ensureRole(
	db: CoreDatabase,
	userId: number,
	roleKey: string,
	networkId: number | null,
): void {
	const role = db
		.select({ id: rolesTable.id })
		.from(rolesTable)
		.where(eq(rolesTable.key, roleKey))
		.get()
	if (!role) throw new Error(`role ${roleKey} missing; run the roles step first`)
	db.insert(userRolesTable)
		.values({
			user_id: userId,
			role_id: role.id,
			network_id: networkId,
			granted_at: new Date(),
		})
		.onConflictDoNothing()
		.run()
}

const rootUserStep: SeedStep = {
	name: "root user",
	run(db, { rootEmail }) {
		if (!rootEmail) return "skipped (pass --root-email to create one)"
		const userId = ensureUser(db, rootEmail.toLowerCase(), "Root")
		ensureRole(db, userId, "root", null)
		return rootEmail
	},
}

/** Fixture users, roles and a network for e2e suites (here and in the client repos). */
export const TEST_FIXTURES = {
	city: { slug: "kocaeli", name: { tr: "Kocaeli", en: "Kocaeli" } },
	networks: [
		{ slug: "kocaeli-ulasimpark", name: "UlaşımPark" },
		{ slug: "test-network-b", name: "Test network B" },
	],
	users: [
		{
			email: "root@test.gezcez.com",
			display_name: "Root Fixture",
			role: "root",
			network: null,
		},
		{
			email: "admin@test.gezcez.com",
			display_name: "Admin Fixture",
			role: "admin",
			network: null,
		},
		{
			email: "moderator@test.gezcez.com",
			display_name: "Moderator Fixture",
			role: "moderator",
			network: null,
		},
		{
			email: "netadmin@test.gezcez.com",
			display_name: "Network Admin Fixture",
			role: "network_admin",
			network: "kocaeli-ulasimpark",
		},
		{
			email: "analyst@test.gezcez.com",
			display_name: "Analyst Fixture",
			role: "analyst",
			network: "kocaeli-ulasimpark",
		},
		{
			email: "rider@test.gezcez.com",
			display_name: "Rider Fixture",
			role: null,
			network: null,
		},
	],
} as const

const testFixturesStep: SeedStep = {
	name: "test fixtures",
	run(db, { environment }) {
		if (environment !== "test") return "skipped"
		const city =
			db
				.select()
				.from(citiesTable)
				.where(eq(citiesTable.slug, TEST_FIXTURES.city.slug))
				.get() ??
			db
				.insert(citiesTable)
				.values({ ...TEST_FIXTURES.city, status: "public" })
				.returning()
				.get()
		const networkIds = new Map<string, number>()
		for (const network of TEST_FIXTURES.networks) {
			const row =
				db.select().from(networksTable).where(eq(networksTable.slug, network.slug)).get() ??
				db
					.insert(networksTable)
					.values({
						...network,
						city_id: city.id,
						status: "public",
						created_at: new Date(),
					})
					.returning()
					.get()
			networkIds.set(network.slug, row.id)
		}
		for (const user of TEST_FIXTURES.users) {
			const userId = ensureUser(db, user.email, user.display_name)
			if (user.role)
				ensureRole(
					db,
					userId,
					user.role,
					user.network ? networkIds.get(user.network)! : null,
				)
		}
		return `${TEST_FIXTURES.users.length} users`
	},
}

export const SEED_STEPS: SeedStep[] = [
	appsStep,
	permissionsStep,
	rolesStep,
	rootUserStep,
	testFixturesStep,
]

/** Runs every step inside one transaction. */
export function runSeed(db: CoreDatabase, context: SeedContext): string[] {
	return db.transaction((tx) =>
		SEED_STEPS.map(
			(step) => `${step.name}: ${step.run(tx as unknown as CoreDatabase, context)}`,
		),
	)
}
