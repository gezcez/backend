// test/helpers/dash.ts
// Dashboard API calls as the seeded fixture users (tokens cached per user), plus helpers to
// look rows up and to make the step-up window lapse.

import { eq } from "drizzle-orm"
import { DatabaseService } from "@db"
import { networksTable, usersTable } from "@schemas/core"
import type { TestApp } from "./app"
import { accessTokenFor } from "./oauth-client"

export interface ApiResult<T> {
	status: number
	headers: Headers
	body: {
		ok: boolean
		data: T
		error: { code: string; message: string; details?: Record<string, unknown> }
	}
}

export const FIXTURE = {
	root: "root@test.gezcez.com",
	admin: "admin@test.gezcez.com",
	moderator: "moderator@test.gezcez.com",
	netadmin: "netadmin@test.gezcez.com",
	analyst: "analyst@test.gezcez.com",
	rider: "rider@test.gezcez.com",
} as const

export class DashClient {
	private readonly tokens = new Map<string, string>()

	constructor(readonly t: TestApp) {}

	get db() {
		return this.t.app.get(DatabaseService).core
	}

	async token(email: string, fresh = false): Promise<string> {
		const cached = this.tokens.get(email)
		if (cached && !fresh) return cached
		const { accessToken } = await accessTokenFor(this.t, email)
		this.tokens.set(email, accessToken)
		return accessToken
	}

	/** Drops the cached token (after its session was revoked, for example). */
	forget(email: string): void {
		this.tokens.delete(email)
	}

	async call<T = unknown>(
		as: string | null,
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<ApiResult<T>> {
		const token = as ? await this.token(as) : undefined
		return this.t.json(path, {
			method,
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}) as Promise<ApiResult<T>>
	}

	get<T = unknown>(as: string | null, path: string) {
		return this.call<T>(as, "GET", path)
	}

	user(email: string) {
		return this.db.select().from(usersTable).where(eq(usersTable.email, email)).get()!
	}

	publicId(email: string): string {
		return this.user(email).public_id
	}

	networkId(slug: string): number {
		return this.db.select().from(networksTable).where(eq(networksTable.slug, slug)).get()!.id
	}

	/** Runs `fn` while every token counts as too old for sudo routes. */
	async withStaleAuth<T>(fn: () => Promise<T>): Promise<T> {
		const config = this.t.config as { stepUpMaxAgeS: number }
		const previous = config.stepUpMaxAgeS
		config.stepUpMaxAgeS = -1
		try {
			return await fn()
		} finally {
			config.stepUpMaxAgeS = previous
		}
	}

	/**
	 * Creates a global role holding exactly `permissions` (as admin) and grants it to `email`.
	 * Returns the role id.
	 */
	async grantCustomRole(email: string, key: string, permissions: string[]): Promise<number> {
		const created = await this.call<{ id: number }>(FIXTURE.admin, "POST", "/v1/dash/roles", {
			key,
			name: key,
			level: 50,
		})
		if (created.status !== 201 && created.status !== 200)
			throw new Error(`role ${key}: ${JSON.stringify(created.body)}`)
		const roleId = created.body.data.id
		const put = await this.call(FIXTURE.admin, "PUT", `/v1/dash/roles/${roleId}/permissions`, {
			permissions,
		})
		if (put.status !== 200) throw new Error(`role ${key}: ${JSON.stringify(put.body)}`)
		const assign = await this.call(
			FIXTURE.admin,
			"POST",
			`/v1/dash/users/${this.publicId(email)}/roles`,
			{ operations: [{ role_id: roleId, op: "grant" }] },
		)
		if (assign.status !== 200) throw new Error(`role ${key}: ${JSON.stringify(assign.body)}`)
		return roleId
	}
}
