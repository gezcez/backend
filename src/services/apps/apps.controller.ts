// apps.controller.ts
// /v1/dash/apps: OAuth client administration.

import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	Req,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { RevokedCountDto } from "@services/account/account.dto"
import { DeletedDto } from "@services/roles/roles.dto"
import {
	AppDetail,
	AppPageDto,
	AppQueryDto,
	AppReasonDto,
	CreateAppDto,
	CreatedAppDto,
	RotatedSecretDto,
	RotateSecretDto,
	SecretRevokedDto,
	UpdateAppDto,
} from "./apps.dto"
import { AppsService } from "./apps.service"

@ApiTags("dash")
@Controller("dash/apps")
export class AppsController {
	constructor(private readonly apps: AppsService) {}

	@Get()
	@UseAuthorization({
		permission: "apps.read",
		scope: "global",
		description: "List OAuth clients",
	})
	@ApiOperation({ summary: "OAuth clients with usage counts; sort name, created_at, tokens_24h" })
	@ApiEnvelope(AppPageDto)
	list(@Query() query: AppQueryDto): AppPageDto {
		return this.apps.list(query)
	}

	@Post()
	@HttpCode(200)
	@UseAuthorization({
		permission: "apps.write",
		scope: "global",
		sudo: true,
		description: "Create an OAuth client",
	})
	@ApiOperation({ summary: "Create a client; a confidential client's secret is shown once" })
	@ApiEnvelope(CreatedAppDto)
	create(@Req() req: Request, @Body() body: CreateAppDto): CreatedAppDto {
		return this.apps.create(req, body)
	}

	@Get(":appId")
	@UseAuthorization({
		permission: "apps.read",
		scope: "global",
		description: "Read an OAuth client",
	})
	@ApiOperation({ summary: "Client detail, secret metadata and tokens issued per day" })
	@ApiEnvelope(AppDetail)
	detail(@Param("appId") appId: string): AppDetail {
		return this.apps.detail(appId)
	}

	@Patch(":appId")
	@UseAuthorization({
		permission: "apps.write",
		scope: "global",
		description: "Edit an OAuth client",
	})
	@ApiOperation({
		summary: "Edit a client",
		description:
			"redirect_uris and first_party changes additionally need a fresh sign-in (403 AUTH_STEP_UP_REQUIRED).",
	})
	@ApiEnvelope(AppDetail)
	update(
		@Req() req: Request,
		@Param("appId") appId: string,
		@Body() body: UpdateAppDto,
	): AppDetail {
		return this.apps.update(req, appId, body)
	}

	@Delete(":appId")
	@UseAuthorization({
		permission: "apps.write",
		scope: "global",
		sudo: true,
		description: "Delete an OAuth client",
	})
	@ApiOperation({ summary: "Delete a client with its grants and tokens (not system apps)" })
	@ApiEnvelope(DeletedDto)
	delete(@Req() req: Request, @Param("appId") appId: string): DeletedDto {
		return this.apps.delete(req, appId)
	}

	@Post(":appId/secret")
	@HttpCode(200)
	@UseAuthorization({
		permission: "apps.secrets.rotate",
		scope: "global",
		sudo: true,
		description: "Rotate a client secret",
	})
	@ApiOperation({
		summary: "Rotate the secret (shown once); the previous one works for the grace",
	})
	@ApiEnvelope(RotatedSecretDto)
	rotate(
		@Req() req: Request,
		@Param("appId") appId: string,
		@Body() body: RotateSecretDto,
	): RotatedSecretDto {
		return this.apps.rotateSecret(req, appId, body)
	}

	@Delete(":appId/secret/previous")
	@UseAuthorization({
		permission: "apps.secrets.rotate",
		scope: "global",
		sudo: true,
		description: "Revoke a client's previous secret",
	})
	@ApiOperation({ summary: "End the previous secret's grace now" })
	@ApiEnvelope(SecretRevokedDto)
	revokePrevious(@Req() req: Request, @Param("appId") appId: string): SecretRevokedDto {
		return this.apps.revokePreviousSecret(req, appId)
	}

	@Post(":appId/revoke-all")
	@HttpCode(200)
	@UseAuthorization({
		permission: "apps.write",
		scope: "global",
		sudo: true,
		description: "Revoke every refresh family of a client",
	})
	@ApiOperation({ summary: "Revoke every refresh family of the client" })
	@ApiEnvelope(RevokedCountDto)
	revokeAll(
		@Req() req: Request,
		@Param("appId") appId: string,
		@Body() body: AppReasonDto,
	): RevokedCountDto {
		return this.apps.revokeAll(req, appId, body.reason)
	}
}
