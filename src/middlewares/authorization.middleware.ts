import Elysia, { t } from "elysia"
import { GezcezError } from "../common/GezcezError"
import { GezcezJWTPayload, OAuthService } from "../services/oauth/oauth.service"
import { NetworkMiddleware } from "./network.middleware"
import { JWTPayload } from "jose"
import { GezcezResponse } from "../common/Gezcez"

// lets do it properly this time.
export const AuthorizationMiddleware = <T extends "global" | "scoped">(config: {
	scope: T
	permission_id: number
	app_key: string
}) =>
	NetworkMiddleware<T>({
		scope: config.scope,
	})
		.guard({
			headers: t.Object({
				access_token: t.String(),
			}),
		})
		.resolve(async ({ headers: { access_token }, network }) => {
			const verified_payload = await OAuthService.verifyJWT(
				access_token,
				config.app_key
			)
			if (!verified_payload) return
			if (config.scope === "scoped") {
				if (!network) return
				const does_permissions_match = await OAuthService.doesPermissionsMatch(
					verified_payload,
					network.id.toString(),
					config.permission_id
				)
				if (!does_permissions_match) return
				return {
					network: network.id,
					payload: verified_payload,
				}
			} else if (config.scope === "global") {
				const does_permissions_match = await OAuthService.doesPermissionsMatch(
					verified_payload,
					"global",
					config.permission_id
				)
				if (!does_permissions_match) return
				return {
					payload: verified_payload,
				}
			}
		})
		.guard({
			beforeHandle({ payload }) {
				if (!payload) {
					return GezcezError("UNAUTHORIZED", { __message: "Not authorized!" })
				}
			},
		})
		.resolve(({ payload }) => {
			if (!payload) throw new Error("payload gone??")
			return { payload: payload as GezcezJWTPayload }
		})
