import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { FavouritesService, TOMBSTONE_TTL_MS } from "@services/favourites/favourites.service"
import { createTestApp, type TestApp } from "../helpers/app"
import { FIXTURE } from "../helpers/dash"
import { accessTokenFor } from "../helpers/oauth-client"

let t: TestApp
let token: string
let dashToken: string

interface Doc {
	version: number
	updated_at: string | null
	groups: {
		id: string
		name: string
		colour: string
		position: number
		items: {
			id: string
			kind: string
			network_id: string
			ref_id: string
			direction?: number
		}[]
	}[]
	tombstones: { id: string; deleted_at: string }[]
}
type Body = { ok: boolean; data: Doc; error: { code: string; details?: Record<string, unknown> } }

function call(method: string, body?: unknown, headers: Record<string, string> = {}, as = token) {
	return t.json<Body>("/v1/me/favourites", {
		method,
		headers: {
			authorization: `Bearer ${as}`,
			...(body ? { "content-type": "application/json" } : {}),
			...headers,
		},
		body: body ? JSON.stringify(body) : undefined,
	})
}

const now = () => new Date().toISOString()
function doc(
	items: { id: string; network_id: string | number }[],
	tombstones: Doc["tombstones"] = [],
) {
	return {
		groups: [
			{
				id: "g-home",
				name: "Home",
				colour: "teal",
				position: 0,
				items: items.map((i) => ({
					id: i.id,
					kind: "stop",
					network_id: i.network_id,
					ref_id: "1.900100",
					label: "Stop",
					direction: 0,
					added_at: now(),
				})),
			},
		],
		tombstones,
	}
}

beforeAll(async () => {
	t = await createTestApp()
	token = (
		await accessTokenFor(t, FIXTURE.rider, { clientId: "e2e_client", scope: "openid transit" })
	).accessToken
	dashToken = (await accessTokenFor(t, FIXTURE.rider)).accessToken
}, 60_000)
afterAll(async () => {
	await t.close()
})

describe("favourites document", () => {
	test("needs a token with the transit scope", async () => {
		expect((await call("GET", undefined, {}, "")).status).toBe(401)
		const res = await call("GET", undefined, {}, dashToken)
		expect(res.status).toBe(403)
		expect(res.body.error.code).toBe("SCOPE_MISSING")
	})

	test("starts empty at version 0", async () => {
		const res = await call("GET")
		expect(res.status).toBe(200)
		expect(res.headers.get("etag")).toBe('"0"')
		expect(res.body.data).toEqual({ version: 0, updated_at: null, groups: [], tombstones: [] })
	})

	test("PUT with If-Match bumps the version; a stale If-Match is 412", async () => {
		const first = await call("PUT", doc([{ id: "f1", network_id: "kocaeli-ulasimpark" }]), {
			"if-match": '"0"',
		})
		expect(first.status).toBe(200)
		expect(first.headers.get("etag")).toBe('"1"')
		expect(first.body.data.version).toBe(1)
		const item = first.body.data.groups[0]!.items[0]!
		expect(item.network_id).toBe("kocaeli-ulasimpark")
		expect(item.direction).toBe(0)

		const stale = await call("PUT", doc([]), { "if-match": '"0"' })
		expect(stale.status).toBe(412)
		expect(stale.body.error.code).toBe("VERSION_CONFLICT")
		expect(stale.body.error.details?.current_version).toBe(1)

		const missing = await call("PUT", doc([]))
		expect(missing.status).toBe(400)
	})

	test("a numeric network id is accepted and returned as the slug; unknown networks fail", async () => {
		const networkId = (
			await t.json<{ data: { id: number } }>("/v1/networks/kocaeli-ulasimpark")
		).body.data.id
		const res = await call(
			"PUT",
			doc([
				{ id: "f1", network_id: "kocaeli-ulasimpark" },
				{ id: "f2", network_id: networkId },
			]),
			{ "if-match": "1" },
		)
		expect(res.status).toBe(200)
		expect(res.body.data.groups[0]!.items.map((i) => i.network_id)).toEqual([
			"kocaeli-ulasimpark",
			"kocaeli-ulasimpark",
		])
		const bad = await call("PUT", doc([{ id: "f3", network_id: "nowhere" }]), {
			"if-match": "2",
		})
		expect(bad.status).toBe(400)
		expect(bad.body.error.code).toBe("VALIDATION_FAILED")
	})

	test("removed ids become tombstones that expire after 30 days", async () => {
		const deletedAt = new Date(Date.now() - 1000).toISOString()
		const res = await call(
			"PUT",
			doc(
				[{ id: "f2", network_id: "kocaeli-ulasimpark" }],
				[{ id: "f1", deleted_at: deletedAt }],
			),
			{
				"if-match": '"2"',
			},
		)
		expect(res.status).toBe(200)
		expect(res.body.data.groups[0]!.items.map((i) => i.id)).toEqual(["f2"])
		expect(res.body.data.tombstones).toEqual([{ id: "f1", deleted_at: deletedAt }])

		// Re-adding a tombstoned id revives it.
		const revived = await call(
			"PUT",
			doc([
				{ id: "f1", network_id: "kocaeli-ulasimpark" },
				{ id: "f2", network_id: "kocaeli-ulasimpark" },
			]),
			{
				"if-match": '"3"',
			},
		)
		expect(revived.body.data.tombstones).toEqual([])
		const removed = await call("PUT", doc([{ id: "f2", network_id: "kocaeli-ulasimpark" }]), {
			"if-match": '"4"',
		})
		expect(removed.body.data.tombstones.map((x) => x.id)).toEqual(["f1"])

		const service = t.app.get(FavouritesService)
		const realNow = service.now
		service.now = () => Date.now() + TOMBSTONE_TTL_MS + 60_000
		try {
			const later = await call("GET")
			expect(later.body.data.tombstones).toEqual([])
			expect(later.body.data.version).toBe(5)
		} finally {
			service.now = realNow
		}
	})

	test("rejects bad documents", async () => {
		const badColour = doc([])
		badColour.groups[0]!.colour = "pink"
		expect((await call("PUT", badColour, { "if-match": '"5"' })).status).toBe(400)
		const dup = doc([
			{ id: "x", network_id: "kocaeli-ulasimpark" },
			{ id: "x", network_id: "kocaeli-ulasimpark" },
		])
		expect((await call("PUT", dup, { "if-match": '"5"' })).status).toBe(400)
	})
})
