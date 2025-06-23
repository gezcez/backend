import Elysia, { t } from "elysia"
import { NetworkMiddleware } from "../middlewares/network.middleware"
import { GezcezResponse } from "../common/Gezcez"
import { GezcezValidationFailedError } from "../common/GezcezError"
import { AuthenticationMiddleware } from "../middlewares/authentication.middleware"
import { AuthorizationMiddleware } from "../middlewares/authorization.middleware"

export const TestController = new Elysia({
	name: "test.controller.ts",
	prefix: "/test",
	tags: ["dev"],
})
	.group("/network_stuff", (app) =>
		app.use(
			NetworkMiddleware.get("/info", ({ network }) => {
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
			AuthorizationMiddleware({
				check_for_aud: "oauth",
				requires_permission_id: 1,
			})
				.get("/network_and_jwt_auth", ({ network, payload }) => {
					return { network, payload }
				})
				.get("/me", ({network}) => network)
		)
	)
