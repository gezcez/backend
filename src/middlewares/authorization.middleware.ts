import Elysia from "elysia"
import { NetworkMiddleware } from "./network.middleware"
import { GezcezResponse } from "../common/Gezcez"
import { AuthenticationMiddleware } from "./authentication.middleware"

export const AuthorizationMiddleware = (config:{
	requires_permission_id?:number,
	requires_authorization_in_network_id?:number,
	check_for_aud:"oauth" | string & {}

}) => new Elysia()
.use(AuthenticationMiddleware({check_for_aud:config.check_for_aud}))
.use(NetworkMiddleware)
