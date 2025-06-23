import Elysia, { t } from "elysia"
import { GezcezError } from "../common/GezcezError"
import { OAuthController } from "../services/oauth/oauth.controller"
import { OAuthService } from "../services/oauth/oauth.service"

export const AuthenticationMiddleware = (config: { check_for_aud:"oauth"|string&{} }) =>
	new Elysia({
		name: "authentication.middleware.ts",
	})
		.guard({
			as: "scoped",
			headers: t.Object({
				access_token: t.String(),
			}),
		})
		.derive({ as: "scoped" }, async ({ headers: { access_token } }) => {
			if (!access_token) return
			let payload
			try {
				payload = await OAuthService.verifyJWT(access_token, config.check_for_aud)
			} catch {}
			if (!payload) return
			if (!payload.is_activated) return
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
