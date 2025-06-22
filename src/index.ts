import { Elysia, t, Context } from "elysia";
import { logger } from "./util";
import { GezcezError } from "./common/GezcezError";
const app = new Elysia()
	.on("error",
		(e) => {
			return GezcezError("INTERNAL_SERVER_ERROR",
				e.error,
				e as Context)
		}
	)
	.get("/error", () => {
		throw new Error("yo ho")
		return
	}, {
		query: t.Optional(t.Object({
			validation: t.String()
		}))
	})
	.listen({
		development: process.env.NODE_ENV === "dev",
		port: process.env.PORT || 80,
		hostname: process.env.HOSTNAME || "localhost"
	}, (server) => {
		logger.success(`Instance is running on ${server.hostname}:${server.port}`)
	});