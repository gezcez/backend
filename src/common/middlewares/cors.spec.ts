import { describe, expect, test } from "bun:test"
import { corsDecision, corsRouteGroup, normaliseOrigin, refreshCookieOrigins } from "./cors"

const config = {
	oauthUiUrl: "https://oauth.gezcez.com",
	corsOrigins: ["https://oauth.gezcez.com", "https://dash.gezcez.com/"],
}
const OAUTH = "https://oauth.gezcez.com"
const DASH = "https://dash.gezcez.com"

describe("corsRouteGroup", () => {
	test("groups paths by the cookie they carry", () => {
		expect(corsRouteGroup("/v1/account/csrf")).toBe("identity")
		expect(corsRouteGroup("/v1/account")).toBe("identity")
		expect(corsRouteGroup("/v1/oauth/authorize/01J/continue")).toBe("identity")
		expect(corsRouteGroup("/v1/oauth/logout")).toBe("identity")
		expect(corsRouteGroup("/v1/oauth/token")).toBe("refresh_cookie")
		expect(corsRouteGroup("/v1/oauth/revoke/")).toBe("refresh_cookie")
		expect(corsRouteGroup("/v1/me")).toBe("bearer")
		expect(corsRouteGroup("/v1/dash/users")).toBe("bearer")
		expect(corsRouteGroup("/v1/accounting")).toBe("bearer")
		expect(corsRouteGroup("/health")).toBe("bearer")
	})
})

describe("corsDecision", () => {
	test("identity routes: the oauth UI only, with credentials", () => {
		expect(corsDecision(config, "/v1/account/profile", OAUTH)).toEqual({ credentials: true })
		expect(corsDecision(config, "/v1/account/profile", DASH)).toBeUndefined()
		expect(corsDecision(config, "/v1/oauth/authorize", DASH)).toBeUndefined()
	})

	test("gz_rt routes: credentials for the dashboard, not for the oauth UI", () => {
		expect(corsDecision(config, "/v1/oauth/token", DASH)).toEqual({ credentials: true })
		expect(corsDecision(config, "/v1/oauth/token", OAUTH)).toEqual({ credentials: false })
		expect(corsDecision(config, "/v1/oauth/token", "https://evil.example")).toBeUndefined()
	})

	test("bearer routes never send credentials", () => {
		expect(corsDecision(config, "/v1/dash/users", DASH)).toEqual({ credentials: false })
		expect(corsDecision(config, "/v1/me", OAUTH)).toEqual({ credentials: false })
		expect(corsDecision(config, "/v1/me", "https://evil.example")).toBeUndefined()
	})

	test("origins are compared in canonical form", () => {
		expect(normaliseOrigin("HTTPS://Dash.Gezcez.com:443/")).toBe(DASH)
		expect(normaliseOrigin("null")).toBeUndefined()
		expect(normaliseOrigin("file:///x")).toBeUndefined()
		expect(corsDecision(config, "/v1/oauth/token", "https://dash.gezcez.com:443")).toEqual({
			credentials: true,
		})
		expect([...refreshCookieOrigins(config)]).toEqual([DASH])
	})
})
