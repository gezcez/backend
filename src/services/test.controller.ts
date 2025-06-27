import Elysia, { t } from "elysia"
import { GezcezResponse } from "../common/Gezcez"
import { GezcezValidationFailedError } from "../common/GezcezError"
import { NetworkMiddleware } from "../middlewares/old.network.middleware"
import { AuthorizationMiddleware } from "../middlewares/old.authorization.middleware"

export const TestController = new Elysia()
const dont_export = new Elysia({
	name: "test.controller.ts",
	prefix: "/test",
	tags: ["dev"],
})
	.group("/network_stuff", (app) =>
		app.use(
			NetworkMiddleware().get("/info", ({ network }) => {
				return GezcezResponse({ network: network })
			})
		)
	)
	.get(
		"/error",
		(c) => {
			return GezcezValidationFailedError(c, "query:validation")
		},
		{
			query: t.Optional(
				t.Object({
					validation: t.String(),
				})
			),
		}
	)

	.group("/network/", (app) =>
		app.use(
			AuthorizationMiddleware({ app_key: "oauth", permission_id: 1, scope: "global" })
				.get("/network_and_jwt_auth", ({ network, payload }) => {
					return { network, payload }
				})
				.get("/me", ({ network }) => network)
		)
	)
