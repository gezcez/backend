// roles.module.ts
// Global: provides PERMISSION_RESOLVER for @UseAuthorization anywhere, and RolesService.

import { Global, Module } from "@nestjs/common"
import { DiscoveryModule } from "@nestjs/core"
import { PERMISSION_RESOLVER } from "@common/authorization"
import { PermissionCacheService } from "./permission-cache.service"
import { PermissionRegistryService } from "./permission-registry.service"
import { RolesAdminRepository } from "./roles-admin.repository"
import { RolesAdminService } from "./roles-admin.service"
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
		RolesAdminRepository,
		RolesAdminService,
		PermissionCacheService,
		PermissionRegistryService,
		{ provide: PERMISSION_RESOLVER, useExisting: PermissionCacheService },
	],
	exports: [
		RolesService,
		RolesAdminRepository,
		RolesAdminService,
		PermissionCacheService,
		PermissionRegistryService,
		PERMISSION_RESOLVER,
	],
})
export class RolesModule {}
