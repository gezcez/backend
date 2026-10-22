import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestApp, type TestApp } from "../helpers/app"
import { TestBrowser } from "../helpers/browser"
import { DashClient, FIXTURE } from "../helpers/dash"

let t: TestApp
let dash: DashClient

beforeAll(async () => {
	t = await createTestApp()
	dash = new DashClient(t)
})
afterAll(async () => {
	await t.close()
})

interface Flag {
	key: string
	critical: boolean
	value: unknown
	default: unknown
	is_default: boolean
	updated_by: { id: string } | null
}

describe("flags", () => {
	test("list, set, validate, reset; app config follows at once", async () => {
		const list = await dash.get<Flag[]>(FIXTURE.admin, "/v1/dash/flags")
		expect(list.status).toBe(200)
		expect(list.body.data.map((f) => f.key)).toContain("app.features")
		expect(list.body.data.map((f) => f.key)).not.toContain("settings.signup")
		expect(list.body.data.find((f) => f.key === "app.kill_switches")!.critical).toBe(true)
		expect((await dash.get(FIXTURE.moderator, "/v1/dash/flags")).status).toBe(403)

		// Warm the app config cache first: the write must still show up immediately.
		expect(
			(await t.json<{ data: { flags: object } }>("/v1/app/config")).body.data.flags,
		).toEqual({})
		const set = await dash.call<Flag>(FIXTURE.admin, "PUT", "/v1/dash/flags/app.features", {
			value: { trip_planner: true },
		})
		expect(set.body.data).toMatchObject({
			value: { trip_planner: true },
			is_default: false,
			updated_by: { id: dash.publicId(FIXTURE.admin) },
		})
		const config = await t.json<{ data: { flags: object } }>("/v1/app/config")
		expect(config.body.data.flags).toEqual({ trip_planner: true })

		const invalid = await dash.call(FIXTURE.admin, "PUT", "/v1/dash/flags/app.features", {
			value: { trip_planner: "yes" },
		})
		expect(invalid.body.error.code).toBe("VALIDATION_FAILED")
		const unknown = await dash.call(FIXTURE.admin, "PUT", "/v1/dash/flags/nope", { value: 1 })
		expect(unknown.status).toBe(404)
		const settingsKey = await dash.call(
			FIXTURE.admin,
			"PUT",
			"/v1/dash/flags/settings.signup",
			{
				value: { open: false },
			},
		)
		expect(settingsKey.body.error.code).toBe("VALIDATION_FAILED")

		const reset = await dash.call<Flag>(FIXTURE.admin, "PUT", "/v1/dash/flags/app.features", {
			reset: true,
		})
		expect(reset.body.data).toMatchObject({ value: {}, is_default: true })

		const detail = await dash.get<Flag & { history: { after: unknown }[] }>(
			FIXTURE.admin,
			"/v1/dash/flags/app.features",
		)
		expect(detail.body.data.history.map((h) => h.after)).toEqual([{}, { trip_planner: true }])
	})

	test("critical flags need step-up", async () => {
		const stale = await dash.withStaleAuth(() =>
			dash.call(FIXTURE.admin, "PUT", "/v1/dash/flags/app.kill_switches", {
				value: { live_map: false },
			}),
		)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		const fresh = await dash.call<Flag>(
			FIXTURE.admin,
			"PUT",
			"/v1/dash/flags/app.kill_switches",
			{
				value: { live_map: false },
			},
		)
		expect(fresh.status).toBe(200)
		const config = await t.json<{ data: { kill_switches: object } }>("/v1/app/config")
		expect(config.body.data.kill_switches).toEqual({ cards: true, live_map: false })
		const audit = await dash.get<{ items: { action: string }[] }>(
			FIXTURE.admin,
			"/v1/dash/audit?action=flags.critical_updated",
		)
		expect(audit.body.data.items.length).toBe(1)
	})
})

describe("settings", () => {
	test("PATCH needs step-up; closing sign-up blocks new accounts and shows in the notice", async () => {
		const initial = await dash.get<{ signup: { open: boolean } }>(
			FIXTURE.admin,
			"/v1/dash/settings",
		)
		expect(initial.body.data.signup.open).toBe(true)
		const stale = await dash.withStaleAuth(() =>
			dash.call(FIXTURE.admin, "PATCH", "/v1/dash/settings", { signup: { open: false } }),
		)
		expect(stale.body.error.code).toBe("AUTH_STEP_UP_REQUIRED")
		const unknownGroup = await dash.call(FIXTURE.admin, "PATCH", "/v1/dash/settings", {
			nope: true,
		})
		expect(unknownGroup.body.error.code).toBe("VALIDATION_FAILED")

		const patched = await dash.call<{
			signup: { open: boolean }
			maintenance: { enabled: boolean }
		}>(FIXTURE.admin, "PATCH", "/v1/dash/settings", {
			signup: { open: false },
			maintenance: { enabled: true, message: { tr: "Bakım", en: "Maintenance" } },
		})
		expect(patched.body.data).toMatchObject({
			signup: { open: false },
			maintenance: { enabled: true },
		})
		const notice = await t.json<{ data: unknown }>("/v1/system/notice")
		expect(notice.body.data).toEqual({
			maintenance: { message: { tr: "Bakım", en: "Maintenance" } },
			signup_open: false,
		})

		const browser = new TestBrowser(t)
		await expect(browser.signIn("closed-signup@example.com")).rejects.toThrow(/SIGNUP_CLOSED/)
		// Existing accounts still sign in.
		await browser.signIn(FIXTURE.rider)

		await dash.call(FIXTURE.admin, "PATCH", "/v1/dash/settings", { signup: { open: true } })
		await new TestBrowser(t).signIn("open-signup@example.com")
	})
})
