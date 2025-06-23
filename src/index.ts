import { Elysia, t, Context } from "elysia";
import { swagger } from "@elysiajs/swagger"
import { logger } from "./util";
import { GezcezError, GezcezValidationFailedError } from "./common/GezcezError";
import { OAuthController } from "./services/oauth/oauth.controller";
const app = new Elysia()
	.use(swagger({
		path: "/docs",
		provider: "scalar",
		documentation: {
			info: {
				title: "Gezcez.com Public API Documentation",
				version: "1.0.0",
				contact: {
					email: "info@gezcez.com",
				},
				description: "Public API docs for Gezcez.com, our internal services alo use this API."
			}
		}
	}))
	.on("error",
		(c) => {
			if (c.code == "VALIDATION") {
				const first_error = c.error.all.at(0)
				const error = c.error
				if (first_error.summary) {
					return GezcezValidationFailedError(
						c as any, `${error.type}:${first_error.path?.slice(1)}`,
						(first_error.summary) || "unknown error"
					)
				}
				return GezcezValidationFailedError(
					c as any, `unknown:${(c.error.all.at(0)?.schema.format)}`,
					(c.error.message.summary || c.error.message) || "unknown error"
				)
			}
			if (c.code == "PARSE") {
				return GezcezError("BAD_REQUEST", c.error, c as any)
			}
			return GezcezError("INTERNAL_SERVER_ERROR",
				"hidden due to security",
				c as any)
		}
	)
	.use(OAuthController)
	.get("/error", (c) => {
		return GezcezValidationFailedError(c, "query:validation")
		return
	}, {
		tags: ["dev"],
		query: t.Optional(t.Object({
			validation: t.String()
		})),
	})
	.listen({
		development: process.env.NODE_ENV === "dev",
		port: process.env.PORT || 80,
		hostname: process.env.HOST || "localhost"
	}, (server) => {
		logger.success(`Instance is running on ${server.hostname}:${server.port}`)
	});