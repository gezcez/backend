// shared.controller.ts
import { Controller, Get, Post, Req, Body } from "@nestjs/common"
import { UseGuards } from "@nestjs/common/decorators"
import { ApiHeader } from "@nestjs/swagger"
import type { Request } from "express"
import { UserRepository } from "../user/user.repository"
import { OAuthRepository } from "../oauth/oauth.repository"
import { AuthenticationGuard } from "@common/middlewares"
import { GezcezResponse } from "@gezcez/core"
@Controller("shared")
@ApiHeader({
	name: "Authorization",
	description: "Bearer token",
	required: true,
})
@UseGuards(
	AuthenticationGuard({
		app_key: "inherit",
		is_use_refresh_token: false,
	})
)
export class SharedController {
	@Get("/account/me")
	async getAccountMe(@Req() req: Request) {
		const payload = req["payload"]!
		const user = await OAuthRepository.getUserById(payload.sub, {
			get_raw_email: true,
		})
		return GezcezResponse(
			{
				payload: payload,
				account: user,
			},
			200
		)
	}

	@Get("/account/list-permissions")
	async listPermissions(@Req() req: Request) {
		const payload = req["payload"]!
		const user_permissions = await UserRepository.getUserPermissions(payload.sub)
		return GezcezResponse({ permissions: user_permissions }, 200)
	}

	
	@Get("/account/list-roles")
	async listRoles(@Req() req: Request) {
		const payload = req["payload"]!
		const user_roles = await UserRepository.listUserRolesWithLeftJoin(payload.sub)
		return GezcezResponse({ roles: user_roles }, 200)
	}

	@Get("/account/list-apps")
	async listApps(@Req() req:Request) {
		
	}
}
