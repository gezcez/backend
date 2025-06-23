import Elysia from "elysia"
import { AuthorizationMiddleware } from "../../middlewares/authorization.middleware"
import { GezcezResponse } from "../../common/Gezcez"
import { NetworkRepository } from "../network/network.repository"
import { PermissionsRepository } from "../permissions/permissions.repository"

export const SystemController = new Elysia({
	name: "system.controller.ts",
	tags: ["system"],
	prefix: "/system",
}).use(
	AuthorizationMiddleware({
		check_for_aud: "system",
		requires_permission_id: 2,
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
