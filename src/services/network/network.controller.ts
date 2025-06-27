import { Elysia } from "elysia"
import { NetworkMiddleware } from "../../middlewares/old.network.middleware"
import { AuthorizationMiddleware } from "../../middlewares/old.authorization.middleware"
export const NetworkController = new Elysia({
	name: "network.controller.ts",
	tags: ["network"],
	prefix: "/networks",
}).use(
	NetworkMiddleware()
		.get("/info", ({ network }) => {
			network: network
		})
		.group("/manage", (app) =>
			app
				.use(
					AuthorizationMiddleware({
						check_for_aud: "system",
						check_for_network_authentication: true,
						requires_permission_id: 1,
					})
				)
				.delete("/delete", ({ payload }) => payload)
		)
)
