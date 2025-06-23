import Elysia, { t } from "elysia"
import { GezcezError } from "../common/GezcezError"
import { OAuthController } from "../services/oauth/oauth.controller"
import { GezcezJWTPayload, OAuthService } from "../services/oauth/oauth.service"


export const AuthenticationMiddleware = (config: { aud: "oauth" | (string & {})}) =>
	new Elysia({
		name: "authentication.middleware.ts",
	})
		.guard({
			as: "scoped",
			headers: t.Object({
				access_token: t.String(),
			}),
		})
		.resolve({ as: "scoped" }, async ({ headers: { access_token } }) : Promise<{payload:GezcezJWTPayload}> => {
			if (!access_token) return undefined as any
			let payload
			try {
				payload = await OAuthService.verifyJWT(access_token, config.aud)
			} catch {}
			if (!payload) return undefined as any
			if (!payload.is_activated) return undefined as any
			return { payload: payload }
		})
		.guard({
			as: "scoped",
			async beforeHandle({ payload, set }) {
				if (!payload) {
					set.status = 401
					return GezcezError("NOT_AUTHENTICATED", undefined)
				}
			},
		})
