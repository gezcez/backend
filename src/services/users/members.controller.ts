// members.controller.ts
// /v1/dash/networks/:networkId/members: list, add-member lookup, assignable roles and batch role
// edits under the level rules.

import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { RolesService } from "@services/roles/roles.service"
import { RoleOperationResultsDto, RoleOperationsDto } from "./dash-users.dto"
import { DashUsersService } from "./dash-users.service"
import { CandidateQueryDto, MemberPageDto, MemberQueryDto, RoleRef, UserRef } from "./members.dto"
import { MembersService } from "./members.service"

@ApiTags("dash")
@Controller("dash/networks/:networkId/members")
export class MembersController {
	constructor(
		private readonly members: MembersService,
		private readonly users: DashUsersService,
		private readonly roles: RolesService,
	) {}

	@Get()
	@UseAuthorization({
		permission: "members.read",
		scope: "network",
		description: "List a network's members",
	})
	@ApiOperation({
		summary: "Users holding a role in the network, emails masked",
		description:
			"Filter `role` (key); sort display_name, level (default desc), last_active_at.",
	})
	@ApiEnvelope(MemberPageDto)
	list(
		@Param("networkId") _networkId: string,
		@Query() query: MemberQueryDto,
		@Req() req: Request,
	): MemberPageDto {
		return this.members.list(req.networkId!, query)
	}

	@Get("candidates")
	@UseAuthorization({
		permission: "members.roles.write",
		scope: "network",
		description: "Look up users to add as members",
	})
	@ApiOperation({
		summary:
			"Users to add: username or name prefix (2+ characters); exact email with users.pii.read",
	})
	@ApiEnvelope([UserRef])
	candidates(
		@Param("networkId") _networkId: string,
		@Query() query: CandidateQueryDto,
		@Req() req: Request,
	): UserRef[] {
		return this.members.candidates(req, query.q)
	}

	@Get("assignable-roles")
	@UseAuthorization({
		permission: "members.roles.write",
		scope: "network",
		description: "Roles the caller may assign in a network",
	})
	@ApiOperation({ summary: "Roles strictly below your level in this network" })
	@ApiEnvelope([RoleRef])
	assignable(@Param("networkId") _networkId: string, @Req() req: Request): RoleRef[] {
		return this.members.assignableRoles(req, req.networkId!)
	}

	@Post(":userId/roles")
	@HttpCode(200)
	@UseAuthorization({
		permission: "members.roles.write",
		scope: "network",
		description: "Grant and revoke a member's roles in a network",
	})
	@ApiOperation({
		summary: "Grant or revoke network roles in a batch; level rules per operation",
	})
	@ApiEnvelope(RoleOperationResultsDto)
	assign(
		@Param("networkId") _networkId: string,
		@Param("userId") userId: string,
		@Body() body: RoleOperationsDto,
		@Req() req: Request,
	): RoleOperationResultsDto {
		return {
			results: this.roles.applyOperations(
				req,
				this.users.find(userId).id,
				body.operations,
				req.networkId,
			),
		}
	}
}
