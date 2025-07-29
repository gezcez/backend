import { CanActivate, ExecutionContext } from "@nestjs/common"
import type { Request } from "express"
import { GezcezError, GezcezValidationFailedError } from "../GezcezError"
import { GezcezJWTPayload } from "../types/gezcez"
import { isTokenInvalid, OAuthUtils } from "../utils/oauth"
import { handlePermissionRegistryAndReturnID } from "../utils"
import { PATH_METADATA } from "@nestjs/common/constants"
function joinPaths(...paths: (string | string[])[]): string {
	return paths
		.flat()
		.filter(Boolean)
		.map((p) => p.replace(/^\/|\/$/g, "")) // trim slashes
		.join("/")
		.replace(/^/, "/") // ensure leading slash
}
export interface IAuthorizationConfig<T extends boolean, SCOPE extends "global" | "scoped"> {
	scope: SCOPE
	app_key: string
	sudo_mode?: T
	description?: string
	permission_key: string
	handleFetchFromDb?: T extends true
		? (req: Request, scope_type: "global" | number, permission_id: number) => boolean
		: never
	handleInvalidation?: (payload: GezcezJWTPayload, context: ExecutionContext) => boolean
}
export function AuthorizationGuard<T extends boolean, SCOPE extends "global" | "scoped">(
	config: IAuthorizationConfig<T, SCOPE>
) {
	return class AuthorizationGuardInner implements CanActivate {
		async canActivate(context: ExecutionContext) {
			const handler = context.getHandler()
			const controller = context.getClass()

			const methodPath = Reflect.getMetadata(PATH_METADATA, handler) || ""
			const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) || ""

			const fullPath = joinPaths(controllerPath, methodPath)

			const req = context.switchToHttp().getRequest() as Request
			const permission_id = await handlePermissionRegistryAndReturnID({
				config: {
					app_key: config.app_key,
					permission_key: config.permission_key,
					scope: config.scope,
					sudo_mode: config.sudo_mode || false,
					description: config.description,
				},
				path: fullPath,
				method: req.method,
			})
			if (!permission_id)
				throw GezcezError("INTERNAL_SERVER_ERROR", {
					__message: `${req.path} endpointi için yetkilendirme sistemi bozulmuş.`,
				})
			const sudo_key = req.headers["sudo-key"]
			const token = req.headers.authorization?.split(" ")[1]
			if (!token) {
				throw GezcezError("UNAUTHORIZED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım. (token undefined)",
				})
			}
			const payload = await OAuthUtils.verifyJWT(token, config.app_key)
			if (!payload) {
				throw GezcezError("UNAUTHORIZED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım.",
				})
			}
			if (payload.type !== "access")
				throw GezcezError("BAD_REQUEST", {
					__message: `token.type geçersiz ('access' beklenirken '${payload.type} bulundu')`,
				})
			const network_id = req["network_id"]
			let can_activate = false
			if (config.scope === "scoped") {
				if (!network_id) throw GezcezValidationFailedError("params:network_id", "network_id is undefined")
				can_activate = await OAuthUtils.doesPermissionsMatch(payload, network_id, permission_id)
			} else {
				can_activate = await OAuthUtils.doesPermissionsMatch(payload, "global", permission_id)
			}
			if (!can_activate) {
				throw GezcezError("FORBIDDEN", {
					__message: "Bu işlemi gerçekleştirmek için yetkiniz yok.",
				})
			}
			if (config.sudo_mode) {
				await config.handleFetchFromDb!(req, config.scope === "global" ? "global" : network_id!, permission_id)
			} else if (config.handleFetchFromDb) {
				await config.handleFetchFromDb!(req, config.scope === "scoped" ? "global" : network_id!, permission_id)
			}
			if (config.handleInvalidation) {
				await config.handleInvalidation(payload, context)
			} else {
				const is_invalid = await isTokenInvalid(payload)
				if (is_invalid) {
					throw GezcezError("UNAUTHORIZED", { __message: "Oturumun süresi dolmuş veya çıkış yapılmış." })
				}
			}
			req["payload"] = payload
			return true
		}
	}
}
