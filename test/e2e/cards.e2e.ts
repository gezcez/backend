import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { DatabaseService } from "@db"
import { providerBindingsTable } from "@schemas/core"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import { ProviderError } from "@services/providers/transit-provider.interface"
import { createTestApp, type TestApp } from "../helpers/app"

let t: TestApp
let bindingId: number
const CARD = "1234567890"

type Body<T> = { ok: boolean; data: T; error: { code: string } }

function post<T>(path: string, body: unknown) {
	return t.json<Body<T>>(`/v1/networks/kocaeli-ulasimpark/cards/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})
}

const month = new Date().toISOString().slice(0, 7)
const nowS = Math.floor(Date.now() / 1000)

beforeAll(async () => {
	t = await createTestApp()
	const networks = t.app.get(NetworksService)
	bindingId = networks.bindings(networks.network("kocaeli-ulasimpark").id)[0]!.id
	const fake = t.app.get(ProvidersRegistry).fake
	fake.setCard(bindingId, CARD, {
		balance: { balance: 42.5, currency: "TRY", asOf: nowS, cardType: "student" },
		history: [
			{
				at: nowS - 60,
				kind: "boarding",
				amount: -7.5,
				balanceAfter: 42.5,
				routeShortName: "F1",
			},
			{ at: nowS - 120, kind: "topup", amount: 50, balanceAfter: 50, routeShortName: null },
		],
	})
	fake.setCard(bindingId, "9999999999", new ProviderError("upstream_error", "boom"))
})
afterAll(async () => {
	await t.close()
})

describe("cards", () => {
	test("balance by card number, never cached", async () => {
		const res = await post<{ balance: number; card_type: string }>("lookup", {
			card_number: "1234 5678 90",
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("cache-control")).toBe("no-store")
		expect(res.body.data).toMatchObject({
			balance: 42.5,
			currency: "TRY",
			card_type: "student",
		})
	})

	test("history of a month, newest first", async () => {
		const res = await post<{ items: { kind: string; route_short_name: string | null }[] }>(
			"history",
			{ card_number: CARD, month },
		)
		expect(res.status).toBe(200)
		expect(res.body.data.items.map((i) => i.kind)).toEqual(["boarding", "topup"])
		expect((await post("history", { card_number: CARD, month: "2001-01" })).status).toBe(400)
	})

	test("errors: unknown card, bad format, upstream failure, unsupported network", async () => {
		const unknown = await post("lookup", { card_number: "1111111111" })
		expect(unknown.status).toBe(404)
		expect(unknown.body.error.code).toBe("CARD_NOT_FOUND")
		expect((await post("lookup", { card_number: "12ab" })).status).toBe(400)
		const failed = await post("lookup", { card_number: "9999999999" })
		expect(failed.body.error.code).toBe("PROVIDER_UNAVAILABLE")

		const db = t.app.get(DatabaseService).core
		db.update(providerBindingsTable)
			.set({ capabilities: { card: null } })
			.where(eq(providerBindingsTable.id, bindingId))
			.run()
		try {
			const off = await post("lookup", { card_number: CARD })
			expect(off.status).toBe(404)
			expect(off.body.error.code).toBe("CAPABILITY_UNSUPPORTED")
		} finally {
			db.update(providerBindingsTable)
				.set({ capabilities: {} })
				.where(eq(providerBindingsTable.id, bindingId))
				.run()
		}
	})
})
