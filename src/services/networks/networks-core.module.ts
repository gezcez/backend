// networks-core.module.ts
// Catalog resolution without HTTP: repository, service and the binding health registry. The
// tracker worker imports only this (it reads core.db read-only); the API adds NetworksModule.

import { Global, Module } from "@nestjs/common"
import { BindingHealthRegistry } from "./binding-health.registry"
import { NetworksRepository } from "./networks.repository"
import { NetworksService } from "./networks.service"

@Global()
@Module({
	providers: [NetworksRepository, NetworksService, BindingHealthRegistry],
	exports: [NetworksRepository, NetworksService, BindingHealthRegistry],
})
export class NetworksCoreModule {}
