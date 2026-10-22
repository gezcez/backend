// roles.controller.ts
// Dashboard: roles, the permission matrix, permission keys and the route registry.

import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Put,
	Req,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { GezcezError } from "@common/errors"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import {
	CreateRoleDto,
	DeletedDto,
	PermissionBatchDto,
	PermissionBatchResultDto,
	PermissionInfo,
	PermissionMatrixDto,
	PermissionRegistryEntry,
	ReplacePermissionsDto,
	Role,
	RoleDetail,
	UpdateRoleDto,
} from "./roles.dto"
import { RolesAdminService } from "./roles-admin.service"

function roleId(param: string): number {
	const id = /^\d{1,10}$/.test(param) ? Number(param) : NaN
	if (!Number.isSafeInteger(id)) throw new GezcezError("NOT_FOUND", "Role not found")
	return id
}

@ApiTags("dash")
@Controller("dash")
export class RolesController {
	constructor(private readonly roles: RolesAdminService) {}

	@Get("roles")
	@UseAuthorization({ permission: "roles.read", scope: "global", description: "List roles" })
	@ApiOperation({ summary: "Roles with permission and member counts" })
	@ApiEnvelope([Role])
	list(): Role[] {
		return this.roles.list()
	}

	@Post("roles")
	@HttpCode(200)
	@UseAuthorization({
		permission: "roles.write",
		scope: "global",
		sudo: true,
		description: "Create a role",
	})
	@ApiOperation({ summary: "Create a role (no permissions yet); its level must be below yours" })
	@ApiEnvelope(Role)
	create(@Req() req: Request, @Body() body: CreateRoleDto): Role {
		return this.roles.create(req, body)
	}

	// Literal paths before /roles/:roleId.
	@Get("roles/permission-matrix")
	@UseAuthorization({
		permission: "roles.read",
		scope: "global",
		description: "Read the roles x permissions matrix",
	})
	@ApiOperation({ summary: "Roles x permissions" })
	@ApiEnvelope(PermissionMatrixDto)
	matrix(): PermissionMatrixDto {
		return this.roles.matrix()
	}

	@Post("roles/permissions\\:batch")
	@HttpCode(200)
	@UseAuthorization({
		permission: "roles.write",
		scope: "global",
		sudo: true,
		description: "Grant and revoke role permissions in a batch",
	})
	@ApiOperation({
		summary: "Matrix editor batch: grant or revoke (role, permission) pairs, a result each",
	})
	@ApiEnvelope(PermissionBatchResultDto)
	batch(@Req() req: Request, @Body() body: PermissionBatchDto): PermissionBatchResultDto {
		return this.roles.batch(req, body)
	}

	@Get("roles/:roleId")
	@UseAuthorization({ permission: "roles.read", scope: "global", description: "Read a role" })
	@ApiOperation({ summary: "Role detail with its permissions and members per network" })
	@ApiEnvelope(RoleDetail)
	detail(@Param("roleId") id: string): RoleDetail {
		return this.roles.detail(roleId(id))
	}

	@Patch("roles/:roleId")
	@UseAuthorization({
		permission: "roles.write",
		scope: "global",
		sudo: true,
		description: "Edit a role",
	})
	@ApiOperation({ summary: "Edit a role's name, description or level (not immutable roles)" })
	@ApiEnvelope(Role)
	update(@Req() req: Request, @Param("roleId") id: string, @Body() body: UpdateRoleDto): Role {
		return this.roles.update(req, roleId(id), body)
	}

	@Put("roles/:roleId/permissions")
	@UseAuthorization({
		permission: "roles.write",
		scope: "global",
		sudo: true,
		description: "Replace a role's permission set",
	})
	@ApiOperation({ summary: "Replace a role's permissions (only keys you hold can be added)" })
	@ApiEnvelope(RoleDetail)
	replacePermissions(
		@Req() req: Request,
		@Param("roleId") id: string,
		@Body() body: ReplacePermissionsDto,
	): RoleDetail {
		return this.roles.replacePermissions(req, roleId(id), body.permissions)
	}

	@Get("permissions")
	@UseAuthorization({
		permission: "permissions.read",
		scope: "global",
		description: "List permission keys",
	})
	@ApiOperation({ summary: "Permission keys from code with scope, sudo and description" })
	@ApiEnvelope([PermissionInfo])
	permissions(): PermissionInfo[] {
		return this.roles.permissionInfo()
	}

	@Get("permissions/registry")
	@UseAuthorization({
		permission: "permissions.read",
		scope: "global",
		description: "Read the route to permission registry",
	})
	@ApiOperation({ summary: "Every stored key with its routes, holders and orphan flag" })
	@ApiEnvelope([PermissionRegistryEntry])
	registry(): PermissionRegistryEntry[] {
		return this.roles.registryEntries()
	}

	@Delete("permissions/:key")
	@UseAuthorization({
		permission: "permissions.write",
		scope: "global",
		sudo: true,
		description: "Delete an orphaned permission key",
	})
	@ApiOperation({ summary: "Delete a key that is no longer in code (409 otherwise)" })
	@ApiEnvelope(DeletedDto)
	deletePermission(@Req() req: Request, @Param("key") key: string): DeletedDto {
		return this.roles.deletePermission(req, key)
	}
}
