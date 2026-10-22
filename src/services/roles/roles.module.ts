// roles.module.ts
// Global: provides PERMISSION_RESOLVER for @UseAuthorization anywhere, and RolesService.

import { Global, Module } from "@nestjs/common"
import { DiscoveryModule } from "@nestjs/core"
import { PERMISSION_RESOLVER } from "@common/authorization"
import { PermissionCacheService } from "./permission-cache.service"
import { PermissionRegistryService } from "./permission-registry.service"
import { RolesController } from "./roles.controller"
import { RolesRepository } from "./roles.repository"
import { RolesService } from "./roles.service"

@Global()
@Module({
	imports: [DiscoveryModule],
	controllers: [RolesController],
	providers: [
		RolesRepository,
		RolesService,
		PermissionCacheService,
		PermissionRegistryService,
		{ provide: PERMISSION_RESOLVER, useExisting: PermissionCacheService },
	],
	exports: [RolesService, PermissionCacheService, PermissionRegistryService, PERMISSION_RESOLVER],
})
export class RolesModule {}
