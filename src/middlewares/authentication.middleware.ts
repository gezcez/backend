import {
	CanActivate,
	ExecutionContext,
	Injectable,
	NestMiddleware,
} from "@nestjs/common"
import { GezcezError } from "../common/GezcezError"
import { NextFunction, Request, Response } from "express"
import { OAuthService } from "../services/oauth/oauth.service"

export function AuthenticatoinMiddleware(config: { app_key: string }) {
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
			req["payload"] = payload
			next()
		}
	}
}
