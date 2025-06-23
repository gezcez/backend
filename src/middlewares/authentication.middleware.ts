import jwt from "@elysiajs/jwt"
import Elysia, { t } from "elysia"
import { GezcezError } from "../common/GezcezError"

export const AuthenticationMiddleware = (config?: { jwt_seret: string }) => new Elysia({
	name: "authentication.middleware.ts",
})
	.use(
		jwt({
			name: "jwt",
			secret: config?.jwt_seret || process.env.JWT_SECRET as string,
		})
	)
	.guard({
		as:"scoped",
		headers: t.Object({
			access_token: t.String(),
		}),
	})
	.derive(async ({ jwt, headers: { access_token } }) => {
		const payload = await jwt.verify(access_token)
		return { payload: payload }
	})
	.guard({
		async beforeHandle({ payload, set }) {
			if (!payload) {
				set.status = 401
				return GezcezError("NOT_AUTHENTICATED", undefined)
			}
		},
	})
