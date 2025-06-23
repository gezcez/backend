import { Elysia, t, Context } from "elysia"
import { swagger } from "@elysiajs/swagger"
import { logger } from "./util"
import { GezcezError, GezcezValidationFailedError } from "./common/GezcezError"
import { OAuthController } from "./services/oauth/oauth.controller"
import { TestController } from "./services/test.controller"
import { NetworkController } from "./services/network/network.controller"
import { SystemController } from "./services/system/system.controller"
const app = new Elysia()
	.use(
		swagger({
			path: "/docs",
			provider: "scalar",
			scalarConfig: {
				authentication: {
					http: {
						bearer: { token: "a" },
						basic: { password: "a", username: "a" },
					},
				},
			},
			documentation: {
				info: {
					title: "Gezcez.com Public API Documentation",
					version: "1.0.0",
					contact: {
						email: "info@gezcez.com",
					},
					description: "Public API docs for Gezcez.com, our internal services alo use this API.",
				},
			},
		})
	)
	.on("error", (c) => {
		if (c.code == "VALIDATION") {
			const first_error = c.error.all.at(0)
			const error = c.error
			if (first_error.summary) {
				return GezcezValidationFailedError(c as any, `${error.type}:${first_error.path?.slice(1)}`, first_error.summary || "unknown error")
			}
			return GezcezValidationFailedError(c as any, `unknown:${c.error.all.at(0)?.schema.format}`, c.error.message.summary || c.error.message || "unknown error")
		}
		if (c.code == "PARSE") {
			return GezcezError("BAD_REQUEST", c.error)
		}
		if (c.code == "NOT_FOUND") {
			c.set.status = 404
			return GezcezError("NOT_FOUND", undefined)
		}
		console.error(c.code, c.error)
		return GezcezError("INTERNAL_SERVER_ERROR", "hidden due to security")
	})
	.on("beforeHandle", (c) => {
		logger.log(c.path)
	})
	.use(OAuthController)
	.use(SystemController)
	.use(TestController)
	.use(NetworkController)
	.listen(
		{
			development: process.env.NODE_ENV === "dev",
			port: process.env.PORT || 80,
			hostname: process.env.HOST || "localhost",
		},
		(server) => {
			logger.success(`Instance is running on ${server.hostname}:${server.port}`)
		}
	)
