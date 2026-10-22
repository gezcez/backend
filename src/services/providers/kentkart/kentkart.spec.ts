import { describe, expect, test } from "bun:test"
import {
	fakeJwt,
	fixtureJson,
	jsonResponse,
	protobufResponse,
	stubFetch,
	vehiclesPb,
} from "@test/helpers/kentkart"
import { ProviderError, type BindingContext, type StaticChunk } from "../transit-provider.interface"
import { UpstreamLimiter } from "../upstream-limiter"
import { KentkartAuth, MemoryTokenStore, type StoredToken, type TokenStore } from "./kentkart.auth"
import { checkEnvelope } from "./kentkart.client"
import { classifyKentkartVehicle, parseKentkartConfig } from "./kentkart.filters"
import {
	daysMaskFromDescription,
	decodeVehicleFeed,
	mapPath,
	mapRouteList,
	parseOffset,
	startTimes,
} from "./kentkart.mapper"
import { KentkartProvider } from "./kentkart.provider"
import type { KentkartPathInfoResponse, KentkartRouteListResponse } from "./kentkart.types"

const BINDING: BindingContext = {
	id: 1,
	networkId: 1,
	providerKey: "kentkart",
	externalRef: "004",
	config: {},
	bbox: [29.25, 40.5, 30.4, 41.2],
	timezone: "Europe/Istanbul",
}

const CREDENTIALS = { clientId: "id", clientSecret: "test-secret", refreshToken: "refresh-xyz" }

function limiter() {
	return new UpstreamLimiter({ maxInFlight: 4, defaultRps: 1000 })
}

describe("kentkart mapper", () => {
	test("decodes GTFS-RT, splits pipe ids and drops unusable entities", () => {
		const feed = decodeVehicleFeed(vehiclesPb())
		expect(feed.feedTs).toBe(1738593361)
		expect(feed.invalid).toBe(2)
		expect(feed.entities).toHaveLength(4)
		const first = feed.entities[0]!
		expect(first).toMatchObject({
			externalId: "41201",
			routeExt: "42041",
			direction: 0,
			tripExt: "2558860",
			stopExt: "41003",
			stopSeq: 2,
			status: 1,
			plate: "41 ABC 123",
			vehicleTs: 1738593311,
		})
		expect(first.lat).toBeCloseTo(40.8244667, 5)
		expect(first.speedMs).toBeCloseTo(2.5)
		// Trip id "0" (intercity) is treated as missing.
		expect(feed.entities[3]!.tripExt).toBeUndefined()
		expect(feed.entities[3]!.routeExt).toBe("44001")
	})

	test("a JSON body is the error envelope with its code", () => {
		const body = new TextEncoder().encode(JSON.stringify(fixtureJson("error-33.json")))
		expect(() => decodeVehicleFeed(body)).toThrow("Please login")
		try {
			decodeVehicleFeed(body)
		} catch (error) {
			expect((error as { upstreamCode?: number }).upstreamCode).toBe(33)
		}
	})

	test("route/list keeps routes only, coerces types and colours, sorts naturally", () => {
		const list = fixtureJson<KentkartRouteListResponse>("route-list.json")
		const { routes, agencies } = mapRouteList(list.routeList!)
		expect(routes.map((r) => r.shortName)).toEqual(["41C", "41K", "GÖREVLİ6", "T1"])
		const c = routes.find((r) => r.shortName === "41C")!
		expect(c).toMatchObject({ externalId: "42041", color: "#0b4f8a", textColor: "#ffffff" })
		expect(routes.find((r) => r.shortName === "T1")).toMatchObject({
			routeType: 0,
			color: "#e30613",
		})
		expect(agencies.map((a) => a.name)).toEqual(["UlaşımPark", "Akçaray"])
	})

	test("days mask follows capital letters, Monday first", () => {
		expect(daysMaskFromDescription("MTWTFss")).toBe(0b0011111)
		expect(daysMaskFromDescription("mtwtfSs")).toBe(0b0100000)
		expect(daysMaskFromDescription("mtwtfsS")).toBe(0b1000000)
	})

	test("offsets accept seconds and clock strings", () => {
		expect(parseOffset("240")).toBe(240)
		expect(parseOffset("00:09:00")).toBe(540)
		expect(parseOffset("")).toBeNull()
		expect(parseOffset("x")).toBeNull()
	})

	test("times after midnight continue the service day", () => {
		expect(
			startTimes([
				{ departureTime: "23:50", tripId: "1" },
				{ departureTime: "00:20", tripId: "2" },
			]),
		).toEqual([85800, 87600])
	})

	test("pathInfo maps to pattern, stops, services and trips", () => {
		const body = fixtureJson<KentkartPathInfoResponse>("path-41C-0.json")
		const mapped = mapPath("42041", body.pathList![0]!)
		expect(mapped.pattern).toMatchObject({
			externalId: "42041.5501",
			routeExternalId: "42041",
			direction: 0,
		})
		expect(mapped.pattern.stops.map((s) => s.offsetS)).toEqual([0, 240, 540, null])
		expect(mapped.pattern.shape).toHaveLength(4)
		expect(mapped.stops.map((s) => s.name)).toContain("Şirintepe")
		expect(mapped.services.map((s) => [s.externalId, s.daysMask])).toEqual([
			["1", 31],
			["2", 32],
			["3", 64],
		])
		expect(mapped.trips.map((t) => [t.externalId, t.startTimeS])).toEqual([
			["2558860", 23400],
			["2558861", 85800],
			["2558862", 87600],
			["2558870", 25200],
			["2558880", 28800],
		])
	})
})

describe("kentkart filters", () => {
	const config = parseKentkartConfig({})
	const base = { externalId: "1", lat: 40.8, lon: 29.9, vehicleTs: 1 }

	test("staff duty routes by code prefix or label", () => {
		expect(classifyKentkartVehicle({ ...base, routeExt: "41906" }, config)).toBe("staff")
		expect(classifyKentkartVehicle({ ...base, label: "GÖREVLİ6-GÖREVLİ6" }, config)).toBe(
			"staff",
		)
		expect(classifyKentkartVehicle({ ...base, label: "Görevli1" }, config)).toBe("staff")
	})

	test("test devices by plate, ignoring spaces and case", () => {
		expect(classifyKentkartVehicle({ ...base, plate: "bld4 test" }, config)).toBe("test")
	})

	test("regular vehicles pass", () => {
		expect(
			classifyKentkartVehicle({ ...base, routeExt: "42041", plate: "41 ABC 123" }, config),
		).toBeNull()
	})

	test("rules come from the binding config", () => {
		const custom = parseKentkartConfig({ staff_route_prefixes: ["999"], test_plates: [] })
		expect(classifyKentkartVehicle({ ...base, routeExt: "41906" }, custom)).toBeNull()
		expect(classifyKentkartVehicle({ ...base, routeExt: "99901" }, custom)).toBe("staff")
	})
})

describe("kentkart auth", () => {
	function tokenEndpoint(iat: number, lifetime = 3600) {
		let n = 0
		return stubFetch([
			[
				(u) => u.pathname.endsWith("/oauth/token"),
				async () => {
					n++
					await Bun.sleep(5)
					return jsonResponse({
						accessToken: fakeJwt({ iat, exp: iat + lifetime, n }),
					})
				},
			],
		])
	}

	test("single flight: concurrent callers share one refresh", async () => {
		const now = 1_700_000_000_000
		const stub = tokenEndpoint(now / 1000)
		const auth = new KentkartAuth({
			realm: "kentkart:rl1:004",
			authUrl: "https://auth.example/rl1",
			region: "004",
			authType: "4",
			credentials: CREDENTIALS,
			store: new MemoryTokenStore(),
			fetchFn: stub.fn,
			userAgent: "test",
			now: () => now,
		})
		const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()])
		expect(new Set(tokens).size).toBe(1)
		expect(stub.calls).toHaveLength(1)
		const body = JSON.parse(String(stub.calls[0]!.init!.body)) as Record<string, string>
		expect(body).toMatchObject({ grantType: "refreshToken", refreshToken: "refresh-xyz" })
		expect(stub.calls[0]!.url).toContain("region=004")
	})

	test("refreshes at 80% of the lifetime and reuses a persisted token", async () => {
		let now = 1_700_000_000_000
		const saved = new Map<string, StoredToken>()
		const store: TokenStore = {
			load: (realm) => saved.get(realm),
			save: (realm, token) => saved.set(realm, token),
			recordFailure: () => {},
		}
		const stub = tokenEndpoint(now / 1000, 1000)
		const make = () =>
			new KentkartAuth({
				realm: "r",
				authUrl: "https://auth.example/rl1",
				region: "004",
				authType: "4",
				credentials: CREDENTIALS,
				store,
				fetchFn: stub.fn,
				userAgent: "test",
				now: () => now,
			})
		const auth = make()
		await auth.getToken()
		now += 700_000
		await auth.getToken()
		expect(stub.calls).toHaveLength(1)
		// A restarted process picks the token up from the store.
		await make().getToken()
		expect(stub.calls).toHaveLength(1)
		now += 150_000 // 850 s of 1000: past 80%
		await auth.getToken()
		expect(stub.calls).toHaveLength(2)
	})

	test("a rejected refresh token puts the realm in auth_failed without leaking secrets", async () => {
		const stub = stubFetch([
			[() => true, () => jsonResponse({ result: { code: 37, message: "nope" } }, 400)],
		])
		const auth = new KentkartAuth({
			realm: "r",
			authUrl: "https://auth.example/rl1",
			region: "004",
			authType: "4",
			credentials: CREDENTIALS,
			store: new MemoryTokenStore(),
			fetchFn: stub.fn,
			userAgent: "test",
		})
		const error = (await auth.getToken().catch((e: unknown) => e)) as ProviderError
		expect(error).toBeInstanceOf(ProviderError)
		expect(error.kind).toBe("auth_failed")
		expect(error.message).not.toContain("test-secret")
		expect(error.message).not.toContain("refresh-xyz")
		expect(auth.status().state).toBe("auth_failed")
		// No hammering: the next call fails fast without another request.
		await auth.getToken().catch(() => undefined)
		expect(stub.calls).toHaveLength(1)
	})

	test("missing credentials are reported, never requested", async () => {
		const stub = stubFetch([])
		const auth = new KentkartAuth({
			realm: "r",
			authUrl: "https://auth.example/rl1",
			region: "004",
			authType: "4",
			credentials: {},
			store: new MemoryTokenStore(),
			fetchFn: stub.fn,
			userAgent: "test",
		})
		await expect(auth.getToken()).rejects.toMatchObject({ kind: "auth_failed" })
		expect(stub.calls).toHaveLength(0)
		expect(auth.status()).toMatchObject({
			state: "missing",
			secretsSet: { KENTKART_CLIENT_SECRET: false },
		})
	})
})

describe("kentkart provider", () => {
	function provider(routes: Parameters<typeof stubFetch>[0], now = () => Date.now()) {
		const stub = stubFetch([
			[
				(u) => u.pathname.endsWith("/oauth/token"),
				() =>
					jsonResponse({
						accessToken: fakeJwt({
							iat: Math.floor(now() / 1000),
							exp: Math.floor(now() / 1000) + 3600,
						}),
					}),
			],
			...routes,
		])
		const p = new KentkartProvider({
			credentials: CREDENTIALS,
			tokenStore: new MemoryTokenStore(),
			limiter: limiter(),
			userAgent: "gezcez-backend/test (+https://gezcez.com/bot)",
			fetchFn: stub.fn,
			now,
			sleep: () => Promise.resolve(),
		})
		return { p, calls: stub.calls }
	}

	const signal = () => new AbortController().signal
	const isFeed = (u: URL) => u.pathname.endsWith("/gtfs/realtime")

	test("fetches the primary feed with token, region and an identifiable user agent", async () => {
		const { p, calls } = provider([[isFeed, () => protobufResponse(vehiclesPb())]])
		const feed = await p.fetchVehicles(BINDING, signal())
		expect(feed.urlVariant).toBe("primary")
		expect(feed.entities).toHaveLength(4)
		const call = calls.find((c) => c.url.includes("gtfs/realtime"))!
		expect(call.url).toStartWith("https://service.kentkart.com/api/gtfs/realtime?")
		expect(call.url).toContain("region=004")
		expect(call.url).not.toContain("antiCache")
		const headers = call.init!.headers as Record<string, string>
		expect(headers.Authorization).toStartWith("Bearer ")
		expect(headers["User-Agent"]).toContain("gezcez-backend")
		expect(headers["Cache-Control"]).toBe("no-cache")
	})

	test("a 401 refreshes the token once and retries", async () => {
		let n = 0
		const { p, calls } = provider([
			[
				isFeed,
				() =>
					n++ === 0 ? new Response("", { status: 401 }) : protobufResponse(vehiclesPb()),
			],
		])
		const feed = await p.fetchVehicles(BINDING, signal())
		expect(feed.entities).toHaveLength(4)
		expect(calls.filter((c) => c.url.includes("oauth/token"))).toHaveLength(2)
	})

	test("code 33 in a JSON body counts as an auth problem; twice is an auth error", async () => {
		const { p } = provider([[isFeed, () => jsonResponse(fixtureJson("error-33.json"))]])
		await expect(p.fetchVehicles(BINDING, signal())).rejects.toMatchObject({ kind: "auth" })
	})

	test("primary failure switches to the fallback; enough successes probe the primary", async () => {
		let now = 1_700_000_000_000
		let primaryOk = false
		const { p, calls } = provider(
			[
				[
					(u) => isFeed(u) && u.pathname.startsWith("/api/"),
					() =>
						primaryOk
							? protobufResponse(vehiclesPb())
							: new Response("<html>bad gateway</html>", { status: 200 }),
				],
				[
					(u) => isFeed(u) && u.pathname.startsWith("/rl1/api/"),
					() => protobufResponse(vehiclesPb()),
				],
			],
			() => now,
		)
		await expect(p.fetchVehicles(BINDING, signal())).rejects.toMatchObject({
			kind: "decode_error",
			details: { urlVariant: "primary" },
		})
		for (let i = 0; i < 10; i++) {
			const feed = await p.fetchVehicles(BINDING, signal())
			expect(feed.urlVariant).toBe("fallback")
			now += 30_000
		}
		// 10 successes and > 10 min since the switch: the next attempt probes the primary.
		now += 600_000
		primaryOk = true
		const probe = await p.fetchVehicles(BINDING, signal())
		expect(probe.urlVariant).toBe("primary")
		expect(p.currentVariant(BINDING.id)).toBe("primary")
		const feedCalls = calls.filter((c) => c.url.includes("gtfs/realtime"))
		expect(feedCalls.at(-1)!.url).toStartWith("https://service.kentkart.com/api/")
	})

	test("429 is rate_limited with Retry-After", async () => {
		const { p } = provider([
			[isFeed, () => new Response("", { status: 429, headers: { "retry-after": "120" } })],
		])
		await expect(p.fetchVehicles(BINDING, signal())).rejects.toMatchObject({
			kind: "rate_limited",
			details: { retryAfterS: 120 },
		})
	})

	test("static data from route/list and pathInfo", async () => {
		const { p, calls } = provider([
			[
				(u) => u.pathname.endsWith("/route/list"),
				() => jsonResponse(fixtureJson("route-list.json")),
			],
			[
				(u) =>
					u.pathname.endsWith("/pathInfo") &&
					u.searchParams.get("displayRouteCode") === "41C",
				(u) =>
					jsonResponse(fixtureJson(`path-41C-${u.searchParams.get("direction")}.json`)),
			],
			[(u) => u.pathname.endsWith("/pathInfo"), () => jsonResponse({ result: { code: 3 } })],
		])
		const chunks: StaticChunk[] = []
		for await (const chunk of p.fetchStatic(BINDING)) chunks.push(chunk)
		const of = (kind: string) =>
			chunks
				.filter((c) => c.kind === kind)
				.flatMap((c) => ("items" in c ? (c.items as unknown[]) : []))
		expect(of("routes")).toHaveLength(4)
		expect(
			of("patterns")
				.map((x) => (x as { externalId: string }).externalId)
				.sort(),
		).toEqual(["42041.5501", "42041.5502"])
		expect(of("stops")).toHaveLength(5)
		expect(of("trips")).toHaveLength(6)
		expect(chunks.filter((c) => c.kind === "warning")).toHaveLength(6)
		expect(calls.every((c) => !String(c.url).includes("antiCache"))).toBe(true)
	})

	test("envelope codes map to error kinds", () => {
		expect(() => checkEnvelope({ result: { code: 0 } })).not.toThrow()
		expect(() => checkEnvelope({ result: { code: "33" } })).toThrow(ProviderError)
		try {
			checkEnvelope({ result: { code: 104 } })
		} catch (error) {
			expect((error as ProviderError).kind).toBe("rate_limited")
		}
	})
})
