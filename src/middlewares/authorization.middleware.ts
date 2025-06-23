import Elysia from "elysia"
import { NetworkMiddleware } from "./network.middleware"
import { GezcezResponse } from "../common/Gezcez"
import { AuthenticationMiddleware } from "./authentication.middleware"

export const AuthorizationMiddleware = () =>
	new Elysia()
		.use(NetworkMiddleware)
		.use(AuthenticationMiddleware())
		.guard({ async beforeHandle({netwo}) {} })
