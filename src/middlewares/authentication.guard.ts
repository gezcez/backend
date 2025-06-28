import {
	CanActivate,
	ExecutionContext,
	Injectable,
	NestMiddleware,
} from "@nestjs/common"
import { GezcezError } from "../common/GezcezError"
import { NextFunction, Request, Response } from "express"
import { GezcezJWTPayload, OAuthService } from "../services/oauth/oauth.service"
import { ApiHeader } from "@nestjs/swagger"
import { db } from "../util"
import { refreshTokensTable } from "../schema/refresh_tokens"
import { eq } from "drizzle-orm"

export function AuthenticationGuard(config: { app_key: string }) {
	class Guard implements CanActivate {
		async canActivate(context: ExecutionContext) {
			const req = context.switchToHttp().getRequest()
			const token = req.headers.authorization?.split(" ")[1]

			if (!token) {
				throw GezcezError("UNAUTHORIZED", {
					__message:
						"Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım. (token undefined)",
				})
			}
			const payload = await OAuthService.verifyJWT(token, config.app_key)
			if (!payload) {
				throw GezcezError("UNAUTHORIZED", {
					__message:
						"Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım. (unverified payload)",
				})
			}
			await handleInvalidation(payload)
			req["payload"] = payload
			return true
		}
	}
	return Guard
}
export async function handleInvalidation(payload: GezcezJWTPayload) {
	const is_refresh_token = payload.aud === "oauth"
	if (is_refresh_token) {
		const [token_data] = await db
			.select()
			.from(refreshTokensTable)
			.where(eq(refreshTokensTable.id, payload.jti))
		if (token_data?.is_invalid) {
			throw GezcezError("UNAUTHORIZED", {
				__message: "Hesabınızdan çıkış yapılmış.",
			})
		}
	}
}
