// users.controller.ts
// GET /v1/me (any valid access token) and PATCH /v1/me (scope `profile`).

import { Body, Controller, Get, Patch } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { RequestAuth } from "@common/jwt.types"
import { ApiEnvelope, Bearer, CurrentAuth, RequireScope } from "@common/middlewares"
import { MeDto, PatchMeDto } from "./users.dto"
import { UsersService } from "./users.service"

@ApiTags("me")
@Controller("me")
export class UsersController {
	constructor(private readonly users: UsersService) {}

	@Get()
	@Bearer()
	@ApiOperation({ summary: "The signed-in user, auth_time, amr, roles and permissions" })
	@ApiEnvelope(MeDto)
	me(@CurrentAuth() auth: RequestAuth): MeDto {
		return this.users.me(auth)
	}

	@Patch()
	@RequireScope("profile")
	@ApiOperation({ summary: "Change display name or locale" })
	@ApiEnvelope(MeDto)
	update(@CurrentAuth() auth: RequestAuth, @Body() body: PatchMeDto): MeDto {
		return this.users.update(auth, body)
	}
}
