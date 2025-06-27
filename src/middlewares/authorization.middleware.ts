import {
	CanActivate,
	ExecutionContext,
	Injectable,
	NestMiddleware,
} from "@nestjs/common"
import { GezcezError, GezcezValidationFailedError } from "../common/GezcezError"
import { NextFunction, Request, Response } from "express"
import { OAuthService } from "../services/oauth/oauth.service"

export function AuthorizationMiddleware(config: {
	scope: "global" | "scoped"
	permission_id: number
	app_key: string
}) {
	return class Guard implements NestMiddleware {
		async use(req: Request, res: Response, next: NextFunction) {
			const token = req.headers.authorization?.split(" ")[1]

			if (!token) {
				return GezcezError("NOT_AUTHENTICATED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım.",
				})
			}
			const payload = await OAuthService.verifyJWT(token, config.app_key)
			if (!payload) {
				return GezcezError("NOT_AUTHENTICATED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım.",
				})
			}
			const network_id = req["network_id"]
			let can_activate = false
			if (config.scope === "scoped") {
				if (!network_id)
					return GezcezValidationFailedError(
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
				return GezcezError("UNAUTHORIZED", {
					__message: "Bu işlemi gerçekleştirmek için yetkiniz yok.",
				})
			}
			next()
		}
	}
}
