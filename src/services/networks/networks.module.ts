// networks.module.ts
// Catalog of networks, providers and bindings with capability resolution. Global because the
// transit, tracker and realtime modules all resolve networks.

import { Global, Module } from "@nestjs/common"
import { BindingHealthRegistry } from "./binding-health.registry"
import { NetworksRepository } from "./networks.repository"
import { NetworksService } from "./networks.service"

@Global()
@Module({
	providers: [NetworksRepository, NetworksService, BindingHealthRegistry],
	exports: [NetworksService, BindingHealthRegistry],
})
export class NetworksModule {}
