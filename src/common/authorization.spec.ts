import { describe, expect, test } from "bun:test"
import {
	actOnUserError,
	assignmentError,
	effectiveLevel,
	emptyPermissions,
	hasPermission,
	permissionsNotHeld,
	type UserPermissions,
} from "./authorization"
import type { PermissionKey } from "./permission-keys"

function user(input: {
	root?: boolean
	global?: PermissionKey[]
	networks?: Record<number, PermissionKey[]>
	globalLevel?: number
	networkLevels?: Record<number, number>
}): UserPermissions {
	return {
		...emptyPermissions(),
		root: input.root ?? false,
		global: new Set(input.global ?? []),
		byNetwork: new Map(
			Object.entries(input.networks ?? {}).map(([id, keys]) => [Number(id), new Set(keys)]),
		),
		globalLevel: input.globalLevel ?? 0,
		networkLevels: new Map(
			Object.entries(input.networkLevels ?? {}).map(([id, level]) => [Number(id), level]),
		),
	}
}

describe("hasPermission", () => {
	test("global grants apply in every network", () => {
		const analyst = user({ global: ["analytics.read"] })
		expect(hasPermission(analyst, "analytics.read", 1)).toBe(true)
		expect(hasPermission(analyst, "analytics.read", 99)).toBe(true)
		expect(hasPermission(analyst, "analytics.read")).toBe(true)
	})

	test("network grants apply only in that network and never to global checks", () => {
		const local = user({ networks: { 1: ["analytics.read", "audit.read"] } })
		expect(hasPermission(local, "analytics.read", 1)).toBe(true)
		expect(hasPermission(local, "analytics.read", 2)).toBe(false)
		expect(hasPermission(local, "analytics.read")).toBe(false)
		// audit.read can be held per network; a global audit check still needs a global grant.
		expect(hasPermission(local, "audit.read", 1)).toBe(true)
		expect(hasPermission(local, "audit.read")).toBe(false)
	})

	test("global-only keys are never satisfied by a network grant", () => {
		const odd = user({ networks: { 1: ["users.read"] } })
		expect(hasPermission(odd, "users.read", 1)).toBe(false)
	})

	test("root passes every check", () => {
		const root = user({ root: true })
		expect(hasPermission(root, "permissions.write")).toBe(true)
		expect(hasPermission(root, "tracker.control", 5)).toBe(true)
		expect(permissionsNotHeld(root, ["providers.kill"])).toEqual([])
	})
})

describe("assignment level rules (escalation)", () => {
	const admin = user({ globalLevel: 900 })
	const netAdmin = user({ networkLevels: { 1: 500 } })
	const moderator = user({ globalLevel: 300 })
	const nobody = user({})
	const base = { executorId: 1, targetId: 2, roleImmutable: false }

	test("effective level is the max of global and the network", () => {
		const both = user({ globalLevel: 300, networkLevels: { 1: 500 } })
		expect(effectiveLevel(both)).toBe(300)
		expect(effectiveLevel(both, 1)).toBe(500)
		expect(effectiveLevel(both, 2)).toBe(300)
	})

	test("granting a role below your level to someone below you is allowed", () => {
		expect(
			assignmentError({
				...base,
				executor: admin,
				target: nobody,
				roleLevel: 500,
				networkId: 1,
			}),
		).toBeNull()
		expect(
			assignmentError({
				...base,
				executor: netAdmin,
				target: nobody,
				roleLevel: 200,
				networkId: 1,
			}),
		).toBeNull()
	})

	test("granting a role equal to your own level is refused (the legacy escalation bug)", () => {
		expect(
			assignmentError({
				...base,
				executor: netAdmin,
				target: nobody,
				roleLevel: 500,
				networkId: 1,
			}),
		).toMatchObject({ code: "ROLE_LEVEL_TOO_LOW" })
		expect(
			assignmentError({ ...base, executor: admin, target: nobody, roleLevel: 900 }),
		).toMatchObject({ code: "ROLE_LEVEL_TOO_LOW" })
	})

	test("a network level does not carry into another network or the global scope", () => {
		expect(
			assignmentError({
				...base,
				executor: netAdmin,
				target: nobody,
				roleLevel: 200,
				networkId: 2,
			}),
		).toMatchObject({ code: "ROLE_LEVEL_TOO_LOW" })
		expect(
			assignmentError({ ...base, executor: netAdmin, target: nobody, roleLevel: 200 }),
		).toMatchObject({ code: "ROLE_LEVEL_TOO_LOW" })
	})

	test("targets at or above your level cannot be touched, including through a global role", () => {
		expect(
			assignmentError({
				...base,
				executor: netAdmin,
				target: user({ networkLevels: { 1: 500 } }),
				roleLevel: 100,
				networkId: 1,
			}),
		).toMatchObject({ code: "ROLE_LEVEL_TOO_LOW" })
		// A global moderator (300) is level 300 in every network: a network admin (500) may
		// still manage them there, a lower executor may not.
		expect(
			assignmentError({
				...base,
				executor: netAdmin,
				target: moderator,
				roleLevel: 100,
				networkId: 1,
			}),
		).toBeNull()
		expect(
			assignmentError({
				...base,
				executor: user({ networkLevels: { 1: 300 } }),
				target: moderator,
				roleLevel: 100,
				networkId: 1,
			}),
		).toMatchObject({ code: "ROLE_LEVEL_TOO_LOW" })
	})

	test("nobody edits themselves and immutable roles are never assigned here", () => {
		expect(
			assignmentError({
				...base,
				targetId: 1,
				executor: admin,
				target: admin,
				roleLevel: 100,
			}),
		).toMatchObject({ code: "ROLE_LEVEL_TOO_LOW" })
		expect(
			assignmentError({
				...base,
				roleImmutable: true,
				executor: user({ globalLevel: 1000 }),
				target: nobody,
				roleLevel: 1000,
			}),
		).toMatchObject({ code: "ROLE_IMMUTABLE" })
	})

	test("role edits cannot add permissions the editor lacks", () => {
		const editor = user({ global: ["roles.write", "users.read"] })
		expect(permissionsNotHeld(editor, ["users.read", "users.pii.read"])).toEqual([
			"users.pii.read",
		])
	})
})

describe("actOnUserError", () => {
	const root = user({ root: true, globalLevel: 1000 })
	const admin = user({ globalLevel: 900 })
	const moderator = user({ globalLevel: 300 })
	const netAdmin = user({ networkLevels: { 1: 500 } })
	const check = (executor: UserPermissions, target: UserPermissions, self: "allow" | "deny") =>
		actOnUserError({ executorId: 1, executor, targetId: 2, target, self })

	test("only strictly lower levels, counting every network of the target", () => {
		expect(check(admin, root, "allow")?.code).toBe("ROLE_LEVEL_TOO_LOW")
		expect(check(admin, admin, "allow")?.code).toBe("ROLE_LEVEL_TOO_LOW")
		expect(check(moderator, netAdmin, "allow")?.code).toBe("ROLE_LEVEL_TOO_LOW")
		expect(check(admin, moderator, "allow")).toBeNull()
		expect(check(root, root, "allow")).toBeNull()
	})

	test("acting on oneself follows the self option", () => {
		const self = (option: "allow" | "deny") =>
			actOnUserError({
				executorId: 1,
				executor: admin,
				targetId: 1,
				target: admin,
				self: option,
			})
		expect(self("allow")).toBeNull()
		expect(self("deny")?.code).toBe("ROLE_LEVEL_TOO_LOW")
	})
})
