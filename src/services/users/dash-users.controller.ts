// dash-users.controller.ts
// /v1/dash/users: search, detail, email reveal, admin sessions, activity and global roles.

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { ActivityQueryDto, AuditPageDto } from "@services/audit/audit.dto"
import { AuditQueryService } from "@services/audit/audit-query.service"
import { RolesService } from "@services/roles/roles.service"
import {
	DashUser,
	DashUserPageDto,
	DashUserQueryDto,
	ReasonDto,
	RevealEmailDto,
	RevokedCountDto,
	RoleOperationResultsDto,
	RoleOperationsDto,
	UserSession,
} from "./dash-users.dto"
import { DashUsersService } from "./dash-users.service"

@ApiTags("dash")
@Controller("dash/users")
export class DashUsersController {
	constructor(
		private readonly users: DashUsersService,
		private readonly audit: AuditQueryService,
		private readonly roles: RolesService,
	) {}

	@Get()
	@UseAuthorization({ permission: "users.read", scope: "global", description: "Search users" })
	@ApiOperation({
		summary: "User search",
		description:
			"`q` matches the display name, a username prefix or a public id; with users.pii.read also an email prefix. Sort: created_at, display_name, last_active_at.",
	})
	@ApiEnvelope(DashUserPageDto)
	list(@Req() req: Request, @Query() query: DashUserQueryDto): DashUserPageDto {
		return this.users.list(req, query)
	}

	@Get(":userId")
	@UseAuthorization({ permission: "users.read", scope: "global", description: "Read a user" })
	@ApiOperation({ summary: "User detail with roles everywhere and the active ban" })
	@ApiEnvelope(DashUser)
	detail(@Param("userId") userId: string): DashUser {
		return this.users.detail(userId)
	}

	@Post(":userId/reveal-email")
	@HttpCode(200)
	@UseAuthorization({
		permission: "users.pii.read",
		scope: "global",
		description: "Reveal a user's email address (audited)",
	})
	@ApiOperation({ summary: "Unmasked email of one user; writes an audit row" })
	@ApiEnvelope(RevealEmailDto)
	revealEmail(@Req() req: Request, @Param("userId") userId: string): RevealEmailDto {
		return this.users.revealEmail(req, userId)
	}

	@Get(":userId/sessions")
	@UseAuthorization({
		permission: "users.sessions.revoke",
		scope: "global",
		description: "List a user's sessions and refresh families",
	})
	@ApiOperation({ summary: "Live SSO sessions (sso_*) and refresh families per app (rf_*)" })
	@ApiEnvelope([UserSession])
	sessions(@Param("userId") userId: string): UserSession[] {
		return this.users.listSessions(userId)
	}

	@Delete(":userId/sessions/:sessionId")
	@UseAuthorization({
		permission: "users.sessions.revoke",
		scope: "global",
		description: "Revoke one session or refresh family of a user",
	})
	@ApiOperation({
		summary: "Revoke one session (and the refresh families issued under it) or one family",
	})
	@ApiEnvelope(RevokedCountDto)
	revokeSession(
		@Req() req: Request,
		@Param("userId") userId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: ReasonDto,
	): RevokedCountDto {
		return this.users.revokeSession(req, userId, sessionId, body.reason)
	}

	@Post(":userId/sessions/revoke-all")
	@HttpCode(200)
	@UseAuthorization({
		permission: "users.sessions.revoke",
		scope: "global",
		sudo: true,
		description: "Sign a user out everywhere",
	})
	@ApiOperation({ summary: "Revoke every session and refresh family of the user" })
	@ApiEnvelope(RevokedCountDto)
	revokeAll(
		@Req() req: Request,
		@Param("userId") userId: string,
		@Body() body: ReasonDto,
	): RevokedCountDto {
		return this.users.revokeAll(req, userId, body.reason)
	}

	@Get(":userId/activity")
	@UseAuthorization({
		permission: "audit.read",
		scope: "global",
		description: "Read a user's audit trail",
	})
	@ApiOperation({ summary: "Audit entries where the user is the actor or the target" })
	@ApiEnvelope(AuditPageDto)
	activity(@Param("userId") userId: string, @Query() query: ActivityQueryDto): AuditPageDto {
		return this.audit.forUser(this.users.find(userId).id, query)
	}

	@Post(":userId/roles")
	@HttpCode(200)
	@UseAuthorization({
		permission: "roles.assign",
		scope: "global",
		sudo: true,
		description: "Grant and revoke global roles",
	})
	@ApiOperation({
		summary: "Grant or revoke global roles in a batch",
		description:
			"Level rules apply per operation: your level must be above the role's and the user's, and nobody edits themselves.",
	})
	@ApiEnvelope(RoleOperationResultsDto)
	assignRoles(
		@Req() req: Request,
		@Param("userId") userId: string,
		@Body() body: RoleOperationsDto,
	): RoleOperationResultsDto {
		return {
			results: this.roles.applyOperations(req, this.users.find(userId).id, body.operations),
		}
	}
}
