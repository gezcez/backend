import { Elysia } from "elysia"
import { NetworkMiddleware } from "../../middlewares/network.middleware"
import { AuthorizationMiddleware } from "../../middlewares/authorization.middleware"
export const NetworkController = new Elysia({
	name: "network.controller.ts",
	tags: ["network"],
}).use(
	NetworkMiddleware.get("/info", ({ network }) => {
		network: network
	}).group("/manage", (app) =>
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
