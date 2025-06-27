import { Context, Elysia, t } from "elysia"
import { db } from "../util"
import { GezcezError } from "../common/GezcezError"
import { ratelimitsTable } from "../schema/ratelimits"
import { and, desc, eq, gt } from "drizzle-orm"
import { GezcezJWTPayload } from "../services/oauth/oauth.service"
export const RatelimitterMiddleware = (config: {
	app_key: string
	key_getter?: (c: Context) => string | undefined
	allowed_rpm: number
	block_for_seconds: number
}) =>
	new Elysia({ name: "ratelimitter.middleware.ts", seed: config })
		.guard({
			beforeHandle: async (c) => {
				const payload = (c as any).payload as GezcezJWTPayload
				console.log("sub",payload.sub)
				// todo
				const identifier =
					(config.key_getter && config.key_getter(c)) || c.headers["CF-Connecting-IP"]

				if (!identifier) {
					c.set.status = 500
					return GezcezError("INTERNAL_SERVER_ERROR", {
						__message: "Ratelimit key error!",
					})
				}
				const key = config.app_key+":user_"+identifier
				// no need for a repository

				const results = await db
					.select()
					.from(ratelimitsTable)
					.where(
						and(
							eq(ratelimitsTable.identifier, key),
							gt(
								ratelimitsTable.created_at,
								new Date(Date.now() - config.block_for_seconds * 1000)
							)
						)
					)
					.orderBy(desc(ratelimitsTable.created_at))
				if (results.length >= config.allowed_rpm) {
					c.set.status = 429
					return GezcezError("RATELIMIT", {
						__message: `You are being ratelimitted for ${
							(config.block_for_seconds-(Date.now()-(results[results.length - 1]?.created_at.getTime()||0))/1000).toFixed(1)
						} seconds`,
					})
				}
				await db.insert(ratelimitsTable).values({
					identifier:key,
					args:{
						path:c.path
					}
				})
			},
			headers:
				process.env.NODE_ENV === "dev"
					? t.Any()
					: t.Object({
							["CF-Connecting-IP"]: t.String({ format: "ipv4" }),
							access_token: t.String(),
					  }),
		}).as("scoped")
