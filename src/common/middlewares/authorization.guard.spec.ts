import { describe, expect, test } from "bun:test"
import { Reflector } from "@nestjs/core"
import type { ExecutionContext } from "@nestjs/common"
import type { AppConfig } from "@common/config"
import { emptyPermissions, type PermissionResolver } from "@common/authorization"
import type { PermissionKey } from "@common/permission-keys"
import {
	AUTHORIZATION_KEY,
	AuthorizationGuard,
	StepUpGuard,
	type AuthorizationOptions,
} from "./authorization.guard"

const NETWORKS: Record<string, number> = { "kocaeli-ulasimpark": 1, "1": 1, "2": 2 }

function resolver(networkKeys: Record<number, PermissionKey[]>): PermissionResolver {
	return {
		forUser: () => ({
			...emptyPermissions(),
			byNetwork: new Map(
				Object.entries(networkKeys).map(([id, keys]) => [Number(id), new Set(keys)]),
			),
		}),
		resolveNetwork: (param) => NETWORKS[param],
	}
}

function context(options: AuthorizationOptions, req: Record<string, unknown>): ExecutionContext {
	const handler = () => undefined
	Reflect.defineMetadata(AUTHORIZATION_KEY, options, handler)
	return {
		getHandler: () => handler,
		getClass: () => class {},
		switchToHttp: () => ({ getRequest: () => req }),
	} as unknown as ExecutionContext
}

const tracker: AuthorizationOptions = {
	permission: "tracker.read",
	scope: "network",
	description: "test",
}

describe("AuthorizationGuard", () => {
	const guard = new AuthorizationGuard(new Reflector(), resolver({ 1: ["tracker.read"] }))

	test("resolves :networkId by slug or id and checks that network", () => {
		const bySlug = { auth: { userId: 7 }, params: { networkId: "kocaeli-ulasimpark" } }
		expect(guard.canActivate(context(tracker, bySlug))).toBe(true)
		expect(bySlug).toMatchObject({ networkId: 1 })
		expect(() =>
			guard.canActivate(
				context(tracker, { auth: { userId: 7 }, params: { networkId: "2" } }),
			),
		).toThrow(
			expect.objectContaining({ code: "PERMISSION_MISSING", details: expect.anything() }),
		)
	})

	test("unknown networks are NOT_FOUND, and a missing auth is AUTH_REQUIRED", () => {
		expect(() =>
			guard.canActivate(
				context(tracker, { auth: { userId: 7 }, params: { networkId: "x" } }),
			),
		).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
		expect(() => guard.canActivate(context(tracker, { params: {} }))).toThrow(
			expect.objectContaining({ code: "AUTH_REQUIRED" }),
		)
	})
})

describe("StepUpGuard", () => {
	const guard = new StepUpGuard({ stepUpMaxAgeS: 600 } as AppConfig)
	const now = Math.floor(Date.now() / 1000)

	test("passes within the window and asks for step-up after it", () => {
		expect(guard.canActivate(context(tracker, { auth: { authTime: now - 300 } }))).toBe(true)
		expect(() =>
			guard.canActivate(context(tracker, { auth: { authTime: now - 601 } })),
		).toThrow(
			expect.objectContaining({ code: "AUTH_STEP_UP_REQUIRED", details: { max_age: 600 } }),
		)
	})
})
