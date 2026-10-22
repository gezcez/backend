// kentkart.provider.ts
// TransitProvider for Kentkart regions: GTFS-RT vehicle positions with primary and fallback URLs
// (automatic return to primary), static data from route/list and pathInfo, drop rules.

import {
	NO_CAPABILITIES,
	ProviderError,
	type BindingContext,
	type CredentialStatus,
	type DropReason,
	type ExternalRegion,
	type ProviderDescription,
	type RawVehicle,
	type StaticChunk,
	type StaticPattern,
	type StaticService,
	type StaticStop,
	type StaticTrip,
	type TransitProvider,
	type UrlVariant,
	type VehicleFeed,
} from "../transit-provider.interface"
import type { UpstreamLimiter } from "../upstream-limiter"
import {
	KentkartAuth,
	type FetchFn,
	type KentkartCredentials,
	type TokenStore,
} from "./kentkart.auth"
import { KentkartClient } from "./kentkart.client"
import { kentkartError } from "./kentkart.errors"
import {
	classifyKentkartVehicle,
	parseKentkartConfig,
	type KentkartBindingConfig,
} from "./kentkart.filters"
import { decodeVehicleFeed, FeedDecodeError, mapPath, mapRouteList } from "./kentkart.mapper"
import type {
	KentkartCityResponse,
	KentkartPathInfoResponse,
	KentkartRouteListResponse,
} from "./kentkart.types"

export interface KentkartProviderOptions {
	credentials: KentkartCredentials
	tokenStore: TokenStore
	limiter: UpstreamLimiter
	userAgent: string
	fetchFn?: FetchFn
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}

/** pathInfo resultType bits: pointList, busList, busStopList, timeTableList, stopTimeList, scheduleList. */
const PATH_RESULT_TYPE = "101111"

interface VariantState {
	current: UrlVariant
	fallbackSuccesses: number
	lastProbeAt: number
}

export class KentkartProvider implements TransitProvider {
	readonly key = "kentkart"
	private readonly client: KentkartClient
	private readonly realms = new Map<string, KentkartAuth>()
	private readonly variants = new Map<number, VariantState>()
	private readonly fetchFn: FetchFn
	private readonly now: () => number
	private readonly sleep: (ms: number) => Promise<void>

	constructor(private readonly options: KentkartProviderOptions) {
		this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
		this.now = options.now ?? Date.now
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
		this.client = new KentkartClient({
			fetchFn: this.fetchFn,
			limiter: options.limiter,
			userAgent: options.userAgent,
		})
	}

	describe(): ProviderDescription {
		return {
			key: this.key,
			name: "Kentkart",
			capabilities: {
				...NO_CAPABILITIES,
				stops: true,
				routes: true,
				timetables: true,
				shapes: true,
				realtime_vehicles: true,
				realtime_departures: "estimated",
			},
			pulledData: [
				{
					key: "vehicle_positions",
					is_collected: true,
					can_optout: false,
					details: "Public vehicle positions (GTFS-Realtime) per region",
				},
				{
					key: "timetables",
					is_collected: true,
					can_optout: false,
					details: "Routes, stops, shapes and timetables",
				},
				{
					key: "personal_data",
					is_collected: false,
					can_optout: false,
					details: "No rider or card data is collected",
				},
			],
			rateHint: { host: "service.kentkart.com", requestsPerSecond: 2 },
		}
	}

	config(binding: BindingContext): KentkartBindingConfig {
		return parseKentkartConfig(binding.config)
	}

	private auth(binding: BindingContext, config: KentkartBindingConfig): KentkartAuth {
		const realm = `kentkart:${config.auth_realm}:${binding.externalRef}`
		let auth = this.realms.get(realm)
		if (!auth) {
			auth = new KentkartAuth({
				realm,
				authUrl: config.auth_url,
				region: binding.externalRef,
				authType: config.auth_type,
				credentials: this.options.credentials,
				store: this.options.tokenStore,
				fetchFn: this.fetchFn,
				userAgent: this.options.userAgent,
				now: this.now,
			})
			this.realms.set(realm, auth)
		}
		return auth
	}

	private variant(bindingId: number): VariantState {
		let state = this.variants.get(bindingId)
		if (!state) {
			state = { current: "primary", fallbackSuccesses: 0, lastProbeAt: 0 }
			this.variants.set(bindingId, state)
		}
		return state
	}

	/** Which URL the next request uses: fallback is sticky until enough successes, then probe. */
	nextVariant(binding: BindingContext): { variant: UrlVariant; probe: boolean } {
		const config = this.config(binding)
		const state = this.variant(binding.id)
		if (state.current === "primary") return { variant: "primary", probe: false }
		const probeDue =
			state.fallbackSuccesses >= config.fallback_successes_before_probe &&
			this.now() - state.lastProbeAt >= config.primary_probe_interval_s * 1000
		return probeDue
			? { variant: "primary", probe: true }
			: { variant: "fallback", probe: false }
	}

	resetUrlVariant(binding: BindingContext): void {
		this.variants.delete(binding.id)
	}

	currentVariant(bindingId: number): UrlVariant {
		return this.variants.get(bindingId)?.current ?? "primary"
	}

	async fetchVehicles(binding: BindingContext, signal: AbortSignal): Promise<VehicleFeed> {
		const config = this.config(binding)
		const state = this.variant(binding.id)
		const { variant, probe } = this.nextVariant(binding)
		if (probe) state.lastProbeAt = this.now()
		try {
			const feed = await this.fetchFeed(binding, config, variant, signal)
			if (variant === "primary") {
				if (feed.entities.length === 0 && !probe) this.toFallback(state)
				else if (probe || state.current === "fallback") {
					// Probe succeeded: back to primary.
					state.current = "primary"
					state.fallbackSuccesses = 0
				}
			} else {
				state.fallbackSuccesses++
			}
			return feed
		} catch (error) {
			if (signal.aborted) throw error
			const providerError =
				error instanceof ProviderError
					? error
					: new ProviderError("upstream_error", (error as Error).message)
			providerError.details.urlVariant = variant
			if (
				variant === "primary" &&
				!probe &&
				["decode_error", "upstream_error", "empty"].includes(providerError.kind)
			) {
				this.toFallback(state)
			}
			if (variant === "fallback") state.fallbackSuccesses = 0
			throw providerError
		}
	}

	private toFallback(state: VariantState): void {
		state.current = "fallback"
		state.fallbackSuccesses = 0
		state.lastProbeAt = this.now()
	}

	private async fetchFeed(
		binding: BindingContext,
		config: KentkartBindingConfig,
		variant: UrlVariant,
		signal: AbortSignal,
	): Promise<VehicleFeed> {
		const auth = this.auth(binding, config)
		const base = (variant === "primary" ? config.api_url : config.fallback_url).replace(
			/\/$/,
			"",
		)
		const url = `${base}/gtfs/realtime?${new URLSearchParams({
			region: binding.externalRef,
			authType: config.auth_type,
		})}`
		let refreshed = false
		for (;;) {
			const token = await auth.getToken()
			const response = await this.client.getBinary(url, {
				token,
				timeoutMs: config.request_timeout_ms,
				signal,
			})
			if (response.status === 429 || response.status === 503) {
				throw new ProviderError("rate_limited", `Kentkart answered ${response.status}`, {
					httpStatus: response.status,
					retryAfterS: response.retryAfterS,
				})
			}
			let authProblem = response.status === 401 || response.status === 403
			let decoded: ReturnType<typeof decodeVehicleFeed> | undefined
			if (!authProblem && response.status >= 400) {
				throw new ProviderError("upstream_error", `Kentkart answered ${response.status}`, {
					httpStatus: response.status,
				})
			}
			if (!authProblem) {
				try {
					decoded = decodeVehicleFeed(response.body)
				} catch (error) {
					if (!(error instanceof FeedDecodeError)) throw error
					const code = error.upstreamCode
					if (code !== undefined && kentkartError(code).class === "auth")
						authProblem = true
					else if (code !== undefined && kentkartError(code).class === "rate_limited")
						throw new ProviderError("rate_limited", error.message, {
							upstreamCode: code,
						})
					else
						throw new ProviderError("decode_error", error.message, {
							httpStatus: response.status,
							upstreamCode: code,
						})
				}
			}
			if (authProblem) {
				if (refreshed) {
					throw new ProviderError(
						"auth",
						"Kentkart rejected the access token after a refresh",
						{
							httpStatus: response.status,
						},
					)
				}
				refreshed = true
				await auth.refresh()
				continue
			}
			return {
				feedTs: decoded!.feedTs,
				entities: decoded!.entities,
				invalid: decoded!.invalid,
				urlVariant: variant,
				bytes: response.body.byteLength,
			}
		}
	}

	classify(vehicle: RawVehicle, binding: BindingContext): DropReason | null {
		return classifyKentkartVehicle(vehicle, this.config(binding))
	}

	async refreshCredentials(binding: BindingContext): Promise<void> {
		await this.auth(binding, this.config(binding)).refresh()
	}

	credentialStatus(binding: BindingContext): CredentialStatus {
		return this.auth(binding, this.config(binding)).status()
	}

	async listRegions(): Promise<ExternalRegion[]> {
		const config = parseKentkartConfig({})
		const body = await this.client.getJson<KentkartCityResponse>(
			`${config.static_url.replace(/\/$/, "")}/v2.0/city`,
			{ timeoutMs: config.request_timeout_ms },
		)
		return (body.city ?? []).map((city) => ({
			externalRef: String(city.id),
			name: city.name,
			lat: city.lat ? Number(city.lat) : null,
			lon: city.lon ? Number(city.lon) : null,
			visible: String(city.visible ?? "1") === "1",
		}))
	}

	async *fetchStatic(binding: BindingContext, signal?: AbortSignal): AsyncIterable<StaticChunk> {
		const config = this.config(binding)
		const region = binding.externalRef
		const list = await this.client.getJson<KentkartRouteListResponse>(
			`${config.static_url.replace(/\/$/, "")}/route/list?${new URLSearchParams({ region })}`,
			{ timeoutMs: config.request_timeout_ms, signal },
		)
		const { routes, agencies } = mapRouteList(list.routeList ?? [])
		yield { kind: "agencies", items: agencies }
		yield { kind: "routes", items: routes }

		const stops = new Map<string, StaticStop>()
		const services = new Map<string, StaticService>()
		const jobs = routes.flatMap((route) =>
			([0, 1] as const).map((direction) => ({ route, direction })),
		)
		let cursor = 0
		const worker = async (): Promise<StaticChunk[]> => {
			const out: StaticChunk[] = []
			while (cursor < jobs.length) {
				signal?.throwIfAborted()
				const job = jobs[cursor++]!
				const url = `${config.web_url.replace(/\/$/, "")}/pathInfo?${new URLSearchParams({
					region,
					lang: "tr",
					displayRouteCode: job.route.shortName,
					direction: String(job.direction),
					resultType: PATH_RESULT_TYPE,
				})}`
				try {
					const body = await this.client.getJson<KentkartPathInfoResponse>(url, {
						timeoutMs: config.request_timeout_ms,
						signal,
					})
					const patterns: StaticPattern[] = []
					const trips: StaticTrip[] = []
					for (const path of body.pathList ?? []) {
						const pathDirection = Number(path.direction ?? job.direction)
						if (pathDirection !== job.direction) continue
						const mapped = mapPath(job.route.externalId, path)
						patterns.push(mapped.pattern)
						trips.push(...mapped.trips)
						for (const stop of mapped.stops)
							if (!stops.has(stop.externalId)) stops.set(stop.externalId, stop)
						for (const service of mapped.services)
							if (!services.has(service.externalId))
								services.set(service.externalId, service)
					}
					if (patterns.length) out.push({ kind: "patterns", items: patterns })
					if (trips.length) out.push({ kind: "trips", items: trips })
				} catch (error) {
					if (signal?.aborted) throw error
					out.push({
						kind: "warning",
						message: `pathInfo ${job.route.shortName}/${job.direction}: ${(error as Error).message}`,
					})
				}
				if (config.static_spacing_ms) await this.sleep(config.static_spacing_ms)
			}
			return out
		}
		const results = await Promise.all(
			Array.from({ length: config.static_concurrency }, () => worker()),
		)
		yield { kind: "stops", items: [...stops.values()] }
		yield { kind: "services", items: [...services.values()] }
		for (const chunks of results) for (const chunk of chunks) yield chunk
	}
}
