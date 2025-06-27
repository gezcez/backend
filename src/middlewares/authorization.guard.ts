import {
	CanActivate,
	ExecutionContext
} from "@nestjs/common"
import { Request } from "express"
import { GezcezError, GezcezValidationFailedError } from "../common/GezcezError"
import { OAuthService } from "../services/oauth/oauth.service"

export function AuthorizationGuard(config: {
	scope: "global" | "scoped"
	permission_id: number
	app_key: string
}) {
	return class Guard implements CanActivate {
		async canActivate(context:ExecutionContext) {
			const req = context.switchToHttp().getRequest<Request>()

			const token = req.headers.authorization?.split(" ")[1]

			if (!token) {
				throw GezcezError("NOT_AUTHENTICATED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım. (token undefined)",
				})
			}
			const payload = await OAuthService.verifyJWT(token, config.app_key)
			if (!payload) {
				throw GezcezError("NOT_AUTHENTICATED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım.",
				})
			}
			const network_id = req["network_id"]
			let can_activate = false
			if (config.scope === "scoped") {
				if (!network_id)
					throw GezcezValidationFailedError(
						req,
						"params:network_id",
						"network_id is undefined"
					)
				can_activate = await OAuthService.doesPermissionsMatch(
					payload,
					network_id,
					config.permission_id
				)
			} else {
				can_activate = await OAuthService.doesPermissionsMatch(
					payload,
					"global",
					config.permission_id
				)
			}

			if (!can_activate) {
				throw GezcezError("UNAUTHORIZED", {
					__message: "Bu işlemi gerçekleştirmek için yetkiniz yok.",
				})
			}
			req["payload"] = payload
			return true
		}
	}
}
