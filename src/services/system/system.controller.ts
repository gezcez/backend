import Elysia, { t } from "elysia"
import { SOCKETS } from "../../old.index"
import { GezcezResponse } from "../../common/Gezcez"

import { logger } from "../../util"
import { NetworkRepository } from "../network/network.repository"
import { OAuthService } from "../oauth/oauth.service"
import { PermissionsRepository } from "../permissions/permissions.repository"
import { AuthorizationMiddleware } from "../../middlewares/old.authorization.middleware"

export const SystemController = new Elysia({
	name: "system.controller.ts",
	tags: ["system"],
	prefix: "/system",
})
	.ws("/terminal/", {
		open: async (c) => {
			const token = c.data.query.access_token
			logger.log(
				c.remoteAddress,
				c.id,
				"asks to stream terminal! access_token.length=",
				token.length
			)
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
			c.send({ type: "status", content: "authentication successful!" })
			// 10 is root access
			const isValid = await OAuthService.doesPermissionsMatch(payload, "global", 10)
			// const permissions = await OAuthService.getPermissionIDsFromPayload(payload, "_")
			if (!isValid) {
				c.send({ type: "error", content: "unauthorized" })
				c.close()
				return
			}
			c.send({ type: "status", content: "authorization successful!" })
			logger.log("starting terminal socket!")
			c.send({ type: "data", content: { socket_id: c.id } })
			c.send({ type: "status", content: `connected websocket stream with id: ${c.id}` })
			SOCKETS.set(c.id, c)
			logger.log(`client ${c.id} has connected to websocket successfully!`)
		},
		message: async (c) => {
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
			app_key: "system",
			scope: "global",
			permission_id: 2,
		})
			.group("/networks", (group) =>
				group
					.use(
						AuthorizationMiddleware({
							app_key: "system",
							scope: "global",
							permission_id: 10,
						}).get("/list", async ({ payload, network }) =>
							GezcezResponse({
								networks: await NetworkRepository.list(),
							})
						)
					)
					.use(
						AuthorizationMiddleware({
							app_key: "system",
							scope: "scoped",
							permission_id: 10,
						}).get("yo", ({ network, payload }) => {})
					)
			)
			.group("/permissions", (group) =>
				group.get("/list", async (c) => {
					return GezcezResponse({ permissions: await PermissionsRepository.list() })
				})
			)
	)
