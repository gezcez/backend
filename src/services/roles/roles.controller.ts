// roles.controller.ts
// Dashboard: the permission key and route registry. Role CRUD and assignment endpoints are P2.

import { Controller, Get } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { PermissionListDto } from "./roles.dto"
import { RolesService } from "./roles.service"

@ApiTags("dash")
@Controller("dash/permissions")
export class RolesController {
	constructor(private readonly roles: RolesService) {}

	@Get()
	@UseAuthorization({
		permission: "permissions.read",
		scope: "global",
		description: "List permission keys and the routes they guard",
	})
	@ApiOperation({ summary: "Permission keys (from code) and the guarded route registry" })
	@ApiEnvelope(PermissionListDto)
	list(): PermissionListDto {
		return this.roles.permissionList()
	}
}
