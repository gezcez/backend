import Elysia, { t } from "elysia"
import { AuthorizationMiddleware } from "../../middlewares/authorization.middleware"
import { GezcezResponse } from "../../common/Gezcez"
import { NetworkRepository } from "../network/network.repository"
import { PermissionsRepository } from "../permissions/permissions.repository"
import { logger } from "../../util"
import { SOCKETS } from "../.."
import { OAuthService } from "../oauth/oauth.service"

export const SystemController = new Elysia({
	name: "system.controller.ts",
	tags: ["system"],
	prefix: "/system",
})
	.ws("/terminal/", {
		open: async (c) => {
			const token = c.data.query.access_token
			logger.log(c.remoteAddress, c.id, "asks to stream terminal! access_token.length=", token.length)
			if (!token) {
				c.send({ type: "error", content: "unauthenticated" })
				c.close()
				return
			}
			const payload = await OAuthService.verifyJWT(token, "system")
			if (!payload) {
				c.send({ type: "error", content: "unauthenticated" })
				c.close()
				return
			}
			const permissions = await OAuthService.getPermissionIDsFromPayload(payload, "_")
			if (!permissions.includes(10)) {
				c.send({ type: "error", content: "unauthorized" })
				c.close()
				return
			}
			logger.log("starting terminal socket!")
			c.send({ type: "data", content: { socket_id: c.id } })
			SOCKETS.set(c.id, c)
			logger.log(`client ${c.id} has connected to websocket successfully!`)
		},
		message: async (c)=> {
			if (!SOCKETS.get(c.id)) {
				c.send({ type: "error", content: "unauthenticated" })
				c.close()
				return
			}
		},
		query: t.Object({
			access_token: t.String(),
		}),
		close: (c) => {
			SOCKETS.delete(c.id)
		},
	})
	.use(
		AuthorizationMiddleware({
			check_for_aud: "system",
			requires_permission_id: 10,
		})
			.get("/networks/list", async (c) =>
				GezcezResponse({
					networks: await NetworkRepository.list(),
				})
			)
			.group("/permissions", (group) =>
				group.get("/list", async (c) => {
					return GezcezResponse({ permissions: await PermissionsRepository.list() })
				})
			)
	)
