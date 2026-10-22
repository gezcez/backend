// providers.module.ts
// Upstream adapters for this process. Global so the tracker, the static sync and the catalog
// share one registry (and one upstream limiter).

import { Global, Module } from "@nestjs/common"
import { ProvidersRegistry } from "./providers.registry"

@Global()
@Module({
	providers: [ProvidersRegistry],
	exports: [ProvidersRegistry],
})
export class ProvidersModule {}
