import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { AppConfigRepository } from "@services/app-config/app-config.repository"
import { AppConfigService } from "@services/app-config/app-config.service"
import { createTestApp, type TestApp } from "../helpers/app"

let t: TestApp

interface Config {
	min_supported_version: string
	soft_update_version: string | null
	update: string
	flags: Record<string, boolean>
	kill_switches: Record<string, boolean>
	announcement: { id: string } | null
	tiles_style_url: { light: string; dark: string }
	ws_url: string
}

const get = (query = "") => t.json<{ data: Config }>(`/v1/app/config${query}`)

beforeAll(async () => {
	t = await createTestApp()
})
afterAll(async () => {
	await t.close()
})

describe("app config", () => {
	test("code defaults without any flag", async () => {
		const res = await get("?platform=ios&version=1.0.0")
		expect(res.status).toBe(200)
		expect(res.headers.get("cache-control")).toBe("public, max-age=300")
		expect(res.body.data).toMatchObject({
			min_supported_version: "0.0.0",
			soft_update_version: null,
			update: "none",
			flags: {},
			kill_switches: { cards: true, live_map: true },
			announcement: null,
		})
		expect(res.body.data.tiles_style_url.light).toMatch(/^https:\/\/.+light/)
		expect(res.body.data.ws_url).toMatch(/^ws:\/\/.+\/v1\/ws$/)
	})

	test("flags drive force and soft update, kill switches and the announcement", async () => {
		const flags = t.app.get(AppConfigRepository)
		flags.set("app.min_supported_version", { ios: "1.2.0", android: "1.1.0" })
		flags.set("app.soft_update_version", "1.5.0")
		flags.set("app.features", { new_search: true, bad: "x" })
		flags.set("app.kill_switches", { cards: false })
		flags.set("app.announcement", {
			id: "maint-1",
			level: "warning",
			title: { tr: "Bakım", en: "Maintenance" },
			body: { tr: "Kısa kesinti", en: "Short outage" },
			url: null,
		})
		t.app.get(AppConfigService).invalidate()

		const ios = (await get("?platform=ios&version=1.1.9")).body.data
		expect(ios.min_supported_version).toBe("1.2.0")
		expect(ios.update).toBe("force")
		expect(ios.flags).toEqual({ new_search: true })
		expect(ios.kill_switches).toEqual({ cards: false, live_map: true })
		expect(ios.announcement?.id).toBe("maint-1")

		const android = (await get("?platform=android&version=1.1.9")).body.data
		expect(android.min_supported_version).toBe("1.1.0")
		expect(android.update).toBe("soft")
		expect((await get("?platform=android&version=2.0.0")).body.data.update).toBe("none")
		expect((await get("?platform=web")).status).toBe(400)
	})
})
