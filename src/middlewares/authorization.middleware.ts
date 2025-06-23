import Elysia from "elysia"
import { NetworkMiddleware } from "./network.middleware"
import { GezcezResponse } from "../common/Gezcez"
import { AuthenticationMiddleware } from "./authentication.middleware"
import { GezcezJWTPayload, OAuthService } from "../services/oauth/oauth.service"
import { GezcezError } from "../common/GezcezError"

export const AuthorizationMiddleware = (config: { check_for_aud: "oauth" | (string & {}); requires_permission_id?: number; check_for_network_authentication?: boolean }) =>
	new Elysia({
		name: "authorization.middleware.ts",
		seed: [config.check_for_aud, config.check_for_network_authentication, config.requires_permission_id],
	})
		.use(NetworkMiddleware)
		.use(
			()=>AuthenticationMiddleware({
				aud: config.check_for_aud,
			})
		)
		.guard({
			as: "scoped",
			async beforeHandle({ network, payload: _p, set }) {
				console.log("hiii")
				const nid = config.check_for_network_authentication
				const aud = config.check_for_aud
				const pid = config.requires_permission_id
				let net_to_check = network?.id?.toString()
				const check_pid = typeof pid === "number"
				let payload = _p as GezcezJWTPayload //elysia fix
				if (payload.aud !== aud) {
					set.status = 400
					return GezcezError("BAD_REQUEST", "aud_mismatch")
				}
				if (check_pid && !nid) net_to_check = "_" //global permissions
				const user_permissions = await OAuthService.getPermissionIDsFromPayload(payload, net_to_check)
				console.log(user_permissions,nid,aud,pid)
				if (check_pid) {
					if (!user_permissions.includes(pid)) {
						set.status = 403
						return GezcezError("UNAUTHORIZED", {
							aud: config.check_for_aud,
							missing_permission: config.requires_permission_id,
							check_for_network_authentication: config.check_for_network_authentication,
						})
					}
				}
				return GezcezError("UNAUTHORIZED", {
					aud: config.check_for_aud,
					required_permission: config.requires_permission_id,
					user_permissions:user_permissions,
					check_for_network_authentication: config.check_for_network_authentication,
				})
			},
		})
