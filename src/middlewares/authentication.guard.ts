import {
	CanActivate,
	ExecutionContext,
	Injectable,
	NestMiddleware,
} from "@nestjs/common"
import { GezcezError } from "../common/GezcezError"
import { NextFunction, Request, Response } from "express"
import { OAuthService } from "../services/oauth/oauth.service"
import { ApiHeader } from "@nestjs/swagger"



export function AuthenticationGuard(config: { app_key: string }) {
	
	class Guard implements CanActivate {
		async canActivate(context:ExecutionContext) {
			const req = context.switchToHttp().getRequest()
			const token = req.headers.authorization?.split(" ")[1]

			if (!token) {
				throw GezcezError("NOT_AUTHENTICATED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım. (token undefined)",
				})
			}
			const payload = await OAuthService.verifyJWT(token, config.app_key)
			if (!payload) {
				throw GezcezError("NOT_AUTHENTICATED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım. (unverified payload)",
				})
			}
			req["payload"] = payload
			return true
		}
	}
	return Guard
}
