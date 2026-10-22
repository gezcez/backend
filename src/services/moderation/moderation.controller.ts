// moderation.controller.ts
// Ban, unban and the moderation log.

import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { Ban } from "@services/users/dash-users.dto"
import {
	BanRequestDto,
	ModerationPageDto,
	ModerationQueryDto,
	UnbanRequestDto,
	UnbanResultDto,
} from "./moderation.dto"
import { ModerationService } from "./moderation.service"

@ApiTags("dash")
@Controller("dash")
export class ModerationController {
	constructor(private readonly moderation: ModerationService) {}

	@Post("users/:userId/ban")
	@HttpCode(200)
	@UseAuthorization({
		permission: "moderation.write",
		scope: "global",
		sudo: true,
		description: "Ban a user",
	})
	@ApiOperation({
		summary: "Ban a user",
		description:
			"Sets the user banned, ends every session and refresh family immediately and writes the moderation log.",
	})
	@ApiEnvelope(Ban)
	ban(@Req() req: Request, @Param("userId") userId: string, @Body() body: BanRequestDto): Ban {
		return this.moderation.ban(req, userId, body)
	}

	@Post("users/:userId/unban")
	@HttpCode(200)
	@UseAuthorization({
		permission: "moderation.write",
		scope: "global",
		description: "Lift a ban",
	})
	@ApiOperation({ summary: "Lift a ban" })
	@ApiEnvelope(UnbanResultDto)
	unban(
		@Req() req: Request,
		@Param("userId") userId: string,
		@Body() body: UnbanRequestDto,
	): UnbanResultDto {
		return this.moderation.unban(req, userId, body.reason)
	}

	@Get("moderation")
	@UseAuthorization({
		permission: "moderation.read",
		scope: "global",
		description: "Read the moderation log",
	})
	@ApiOperation({ summary: "Moderation log, newest first; `active=true` lists bans in force" })
	@ApiEnvelope(ModerationPageDto)
	list(@Query() query: ModerationQueryDto): ModerationPageDto {
		return this.moderation.list(query)
	}
}
