// providers.registry.ts
// Maps provider keys to adapter instances for this process. Credentials come from config (env);
// tracker processes pass a vts.db-backed token store, the API process keeps tokens in memory.

import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"
import { MemoryTokenStore, type FetchFn, type TokenStore } from "./kentkart/kentkart.auth"
import { KentkartProvider } from "./kentkart/kentkart.provider"
import { FakeProvider } from "./fake/fake.provider"
import type { TransitProvider } from "./transit-provider.interface"
import { UpstreamLimiter } from "./upstream-limiter"

export const PROVIDER_TOKEN_STORE = Symbol("PROVIDER_TOKEN_STORE")
/** Optional fetch override (tests inject recorded responses; nothing calls upstream in tests). */
export const PROVIDER_FETCH = Symbol("PROVIDER_FETCH")

export const KNOWN_PROVIDER_KEYS = ["kentkart", "fake"] as const

export function userAgent(config: AppConfig): string {
	return `gezcez-backend/${config.version.packageVersion} (+https://gezcez.com/bot)`
}

@Injectable()
export class ProvidersRegistry implements OnModuleInit {
	readonly limiter: UpstreamLimiter
	readonly fake: FakeProvider
	private readonly adapters = new Map<string, TransitProvider>()

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		@Optional() @Inject(PROVIDER_TOKEN_STORE) tokenStore?: TokenStore,
		@Optional() @Inject(PROVIDER_FETCH) fetchFn?: FetchFn,
	) {
		this.limiter = new UpstreamLimiter({
			maxInFlight: config.transit.upstreamMaxInFlight,
			defaultRps: 2,
		})
		this.fake = new FakeProvider(Date.now, { vehicles: config.transit.fakeVehicles })
		this.adapters.set("fake", this.fake)
		this.adapters.set(
			"kentkart",
			new KentkartProvider({
				credentials: config.transit.kentkart,
				tokenStore: tokenStore ?? new MemoryTokenStore(),
				limiter: this.limiter,
				userAgent: userAgent(config),
				fetchFn,
			}),
		)
	}

	onModuleInit(): void {
		for (const adapter of this.adapters.values()) {
			const hint = adapter.describe().rateHint
			this.limiter.setHostRate(hint.host, hint.requestsPerSecond)
		}
	}

	/** The adapter serving bindings of `key`, honouring PROVIDER_REPLAY. */
	get(key: string): TransitProvider | undefined {
		if (this.config.transit.providerReplay.includes(key)) return this.fake
		return this.adapters.get(key)
	}

	/** The real adapter, ignoring replay (descriptions, credential status). */
	adapter(key: string): TransitProvider | undefined {
		return this.adapters.get(key)
	}

	keys(): string[] {
		return [...this.adapters.keys()]
	}

	/** Env hard kill (plan 8.9 level 1). Unknown providers are disabled. */
	envEnabled(key: string): boolean {
		return this.config.transit.providerEnabled[key] ?? false
	}

	isReplayed(key: string): boolean {
		return this.config.transit.providerReplay.includes(key)
	}
}
