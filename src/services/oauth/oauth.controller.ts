// oauth.controller.ts
import {
	Body,
	Controller,
	Post,
	Req,
	UseGuards
} from "@nestjs/common"
import { ApiHeader } from "@nestjs/swagger"
import type { Request } from "express"
import { GezcezResponse } from "../../common/Gezcez"
import { GezcezError } from "../../common/GezcezError"
import { AuthenticationGuard } from "../../middlewares/authentication.guard"
import { AppsRepository } from "../apps/apps.repository"
import { UserRepository } from "../user/user.repository"
import { OAuthDTO } from "./oauth.dto"
import { OAuthRepository } from "./oauth.repository"
import { OAuthService } from "./oauth.service"

@Controller("oauth")
export class OAuthController {
	@Post("/login")
	async login(@Req() req: Request, @Body() form: OAuthDTO.LoginDto) {
		const { email, password } = form
		const user = await OAuthRepository.selectUserByEmailAndPassword(email, password)
		if (!user) {
			return GezcezResponse({ __message: "Invalid email or password!" }, 401)
		}
		return GezcezResponse({
			user: user,
			refresh_token: await OAuthService.signJWT(
				{
					sub: user.id.toString(),
					is_activated: !!user.activated_at,
					jti: crypto.randomUUID(),
				},
				"15d",
				"oauth"
			),
		})
	}

	@ApiHeader({
		name: "Authorization",
		description: "Bearer token",
		required:true
	})
	@UseGuards(AuthenticationGuard({ app_key: "oauth" }))
	@Post("/account/authorize")
	async authorize(@Req() req: Request, @Body() form: OAuthDTO.AuthorizeDto) {
		const {app_key} = form
		const payload= req["payload"]!
		const app_details = await AppsRepository.getAppByKey(app_key)
		if (!app_details) return GezcezError("BAD_REQUEST", "app not found")
		const user_permissions = await UserRepository.getUserPermissionsByAppKey(
			payload.sub,
			app_key
		)
		const scope_payload = new Map()
		for (const permission of user_permissions) {
			const user_p = permission.user_permission
			const details = permission.permission_details
			const scope = details?.type === "scoped" ? user_p.network_id.toString() : "_"
			const current_value = scope_payload.get(scope) || 0
			if (user_p.status === true) {
				scope_payload.set(scope, current_value + 2 ** user_p.permission_id)
			}
		}
		const payload_o = Object.fromEntries(scope_payload.entries())
		if (Object.keys(payload_o).length <= 0) {
			return GezcezError("UNAUTHORIZED", {
				__message: `You do not have access to app '${app_key}'`,
			})
		}
		const access_token = await OAuthService.signJWT(
			{
				scopes: payload_o,
				sub: payload.sub.toString(),
				is_activated: payload.is_activated,
			},
			"1h",
			"system"
		)
		return GezcezResponse(
			{ __message: "Logged in!", access_token: access_token, payload: payload_o },
			200
		)
	}
}
