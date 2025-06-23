import Elysia, { t } from "elysia"
import { NetworkMiddleware } from "../middlewares/network.middleware"
import { GezcezResponse } from "../common/Gezcez"
import { GezcezValidationFailedError } from "../common/GezcezError"
import { AuthenticationMiddleware } from "../middlewares/authentication.middleware"
import jwt from "@elysiajs/jwt"

export const TestController = new Elysia({
	name: "test.controller.ts",
	prefix: "/test",
	tags: ["dev"],
})
	.use(NetworkMiddleware.get("/info", ({ network }) => GezcezResponse({ network: network })))
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
	.use(
		jwt({
			secret: "testing_jwt_secret",
			name: "testing_jwt",
		}).post(
			"/sign",
			({ testing_jwt, body }) => {
				return testing_jwt.sign({ ...body, exp: Date.now() + 60 * 1000 })
			},
			{
				body: t.Object({
					hello: t.Literal("world"),
				}),
			}
		)
	)
	.use(
		AuthenticationMiddleware({ jwt_seret: "testing_jwt_secret" }).get("/auth", ({ payload }) =>
			GezcezResponse({
				__message: "Auth Successfull!",
				payload: payload,
			})
		)
	)
