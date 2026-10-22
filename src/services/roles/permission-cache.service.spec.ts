import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { PERMISSION_CACHE_TTL_MS, PermissionCacheService } from "./permission-cache.service"
import type { RolesRepository } from "./roles.repository"

type Grant = ReturnType<RolesRepository["grantsForUser"]>[number]

function cacheWith(grants: Record<number, Grant[]>) {
	const calls: number[] = []
	const repository = {
		grantsForUser: (userId: number) => {
			calls.push(userId)
			return grants[userId] ?? []
		},
	} as unknown as RolesRepository
	return { cache: new PermissionCacheService(repository), calls }
}

afterEach(() => {
	mock.restore()
})

describe("PermissionCacheService", () => {
	test("merges global and per-network grants, keeps the highest level", () => {
		const { cache } = cacheWith({
			1: [
				{ network_id: null, role_key: "viewer", level: 10, permission_key: "users.read" },
				{ network_id: null, role_key: "admin", level: 50, permission_key: "roles.read" },
				{ network_id: 7, role_key: "netadmin", level: 40, permission_key: "users.read" },
				{ network_id: 7, role_key: "netviewer", level: 20, permission_key: null },
				{ network_id: 7, role_key: "x", level: 5, permission_key: "not.a.real.key" },
			],
		})
		const p = cache.forUser(1)
		expect(p.root).toBe(false)
		expect(p.globalLevel).toBe(50)
		expect([...p.global].sort()).toEqual(["roles.read", "users.read"])
		expect(p.networkLevels.get(7)).toBe(40)
		expect([...p.byNetwork.get(7)!]).toEqual(["users.read"])
	})

	test("only a global root assignment makes a user root", () => {
		const { cache } = cacheWith({
			1: [{ network_id: 3, role_key: "root", level: 100, permission_key: null }],
			2: [{ network_id: null, role_key: "root", level: 100, permission_key: null }],
		})
		expect(cache.forUser(1).root).toBe(false)
		expect(cache.forUser(2).root).toBe(true)
	})

	test("caches per user for the TTL and counts hits and misses", () => {
		const now = spyOn(Date, "now").mockReturnValue(1_000_000)
		const { cache, calls } = cacheWith({})
		cache.forUser(1)
		cache.forUser(1)
		cache.forUser(2)
		expect(calls).toEqual([1, 2])
		expect(cache.stats()).toEqual({ size: 2, hits: 1, misses: 2 })
		now.mockReturnValue(1_000_000 + PERMISSION_CACHE_TTL_MS)
		cache.forUser(1)
		expect(calls).toEqual([1, 2, 1])
	})

	test("invalidates one user or everyone", () => {
		const { cache, calls } = cacheWith({})
		cache.forUser(1)
		cache.forUser(2)
		cache.invalidate(1)
		expect(cache.stats().size).toBe(1)
		cache.forUser(2)
		cache.forUser(1)
		expect(calls).toEqual([1, 2, 1])
		cache.invalidate()
		expect(cache.stats().size).toBe(0)
	})
})
