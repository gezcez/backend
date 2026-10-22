// providers.module.ts
// Upstream adapters for this process. Global so the tracker, the static sync and the catalog
// share one registry (and one upstream limiter). Only the process that writes vts.db persists
// upstream tokens there; the others keep them in memory.

import { Global, Module, type DynamicModule } from "@nestjs/common"
import { ProviderTokensRepository } from "./provider-tokens.repository"
import { PROVIDER_TOKEN_STORE, ProvidersRegistry } from "./providers.registry"

export interface ProvidersModuleOptions {
	/** True in the process that owns vts.db (tracker worker, MODE=tracker, inline runner). */
	persistTokens: boolean
}

@Global()
@Module({})
export class ProvidersModule {
	static forRoot(options: ProvidersModuleOptions): DynamicModule {
		return {
			module: ProvidersModule,
			global: true,
			providers: [
				ProvidersRegistry,
				...(options.persistTokens
					? [
							ProviderTokensRepository,
							{
								provide: PROVIDER_TOKEN_STORE,
								useExisting: ProviderTokensRepository,
							},
						]
					: []),
			],
			exports: [ProvidersRegistry],
		}
	}
}
