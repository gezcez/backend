import { CanActivate, ExecutionContext } from "@nestjs/common"
import { Request } from "express"
import { GezcezError, GezcezValidationFailedError } from "../common/GezcezError"
import { GezcezJWTPayload, OAuthService } from "../services/oauth/oauth.service"
import { refreshTokensTable } from "../schema/refresh_tokens"
import { config, db } from "../util"
import { and, eq } from "drizzle-orm"
import { handleInvalidation } from "./authentication.guard"
import { sudosTable } from "../schema/sudos"

export function AuthorizationGuard<T extends true | false>(config: {
	scope: "global" | "scoped"
	permission_id: number
	app_key: string
	sudo_mode?: T
	always_fetch_from_db?: T extends true ? never : boolean
}) {
	return class Guard implements CanActivate {
		async canActivate(context: ExecutionContext) {
			const req = context.switchToHttp().getRequest<Request>()
			const sudo_key = req.headers["sudo-key"]
			const token = req.headers.authorization?.split(" ")[1]
			if (!token) {
				throw GezcezError("UNAUTHORIZED", {
					__message:
						"Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım. (token undefined)",
				})
			}
			const payload = await OAuthService.verifyJWT(token, config.app_key)
			if (!payload) {
				throw GezcezError("UNAUTHORIZED", {
					__message: "Bu işlemi gerçekleştirmek için giriş yapmış olmanız lazım.",
				})
			}
			const network_id = req["network_id"]
			let can_activate = false
			if (config.scope === "scoped") {
				if (!network_id)
					throw GezcezValidationFailedError(
						"params:network_id",
						"network_id is undefined"
					)
				can_activate = await OAuthService.doesPermissionsMatch(
					payload,
					network_id,
					config.permission_id
				)
			} else {
				can_activate = await OAuthService.doesPermissionsMatch(
					payload,
					"global",
					config.permission_id
				)
			}
			if (!can_activate) {
				throw GezcezError("FORBIDDEN", {
					__message: "Bu işlemi gerçekleştirmek için yetkiniz yok.",
				})
			}
			if (config.sudo_mode) {
				await handleFetchFromDb(
					req,
					config.scope === "scoped" ? network_id! : "global",
					config.permission_id
				)
				await handleSudoMode(req, sudo_key as any)
			} else if (config.always_fetch_from_db) {
				await handleFetchFromDb(
					req,
					config.scope === "scoped" ? network_id! : "global",
					config.permission_id
				)
			}
			await handleInvalidation(payload)
			req["payload"] = payload
			return true
		}
	}
}

async function handleFetchFromDb(
	req: Request,
	network_id: "global" | (string & {}),
	permission_id: number
) {
	const payload = req["payload"]!
	const network_key = network_id === "global" ? "_" : network_id
	const network_number = network_id === "global" ? 0 : parseInt(network_id)
	const user_permissions = await OAuthService.listUserPermissionsWithNetworkId(
		payload.sub,
		network_number
	)
	const payload_scopes = OAuthService.getPermissionIDsFromPayload(
		payload,
		network_key
	)
	if (!payload_scopes.includes(permission_id)) {
		// just in case i remove the upper code by mistake
		throw GezcezError("FORBIDDEN", {
			__message: "Bu işlemi gerçekleştirmek için yetkiniz yok.",
		})
	}
	if (!user_permissions.find((e) => (e.permission_id === permission_id) && (e.network_id === network_number)))
		throw GezcezError("FORBIDDEN", {
			__message:
				"Bu işlemi gerçekleştirmek için gereken yetkiniz kısa süre önce silinmiş.",
		})
}

async function handleSudoMode(req: Request, sudo_key?: string) {
	if (!sudo_key || typeof sudo_key !== "string") {
		throw GezcezError("FORBIDDEN", {
			__message: "Bu işlem için SUDO modunda olmanız lazım.",
			sudo: true,
		})
	}
	const payload = req["payload"]!
	const [sudo_row] = await db
		.select()
		.from(sudosTable)
		.where(
			and(eq(sudosTable.sudo_key, sudo_key), eq(sudosTable.created_by, payload.sub))
		)
		.limit(1)
	if (!sudo_row)
		throw GezcezError("FORBIDDEN", {
			__message: "Bu işlem için SUDO modunda olmanız lazım.",
			sudo: true,
		})
	if (!sudo_row.updated_at)
		throw GezcezError("FORBIDDEN", {
			__message: "SUDO işlemi onaylanmamış.",
		})

	if ((sudo_row.updated_at.getTime() + config.sudo_mode_ttl*1000 < new Date().getTime()))
		throw GezcezError("FORBIDDEN", {
			__message: "SUDO işleminizin süresi dolmuş.",
			sudo:true
		})
	const [refresh_token] = await db
		.select()
		.from(refreshTokensTable)
		.where(
			and(
				eq(refreshTokensTable.id, sudo_row.linked_refresh_token_id),
				eq(refreshTokensTable.created_by, payload.sub)
			)
		)
		.limit(1)
	if (!refresh_token)
		throw GezcezError("FORBIDDEN", {
			__message: "Geçersiz oturum",
		})
	if (refresh_token.is_invalid)
		throw GezcezError("FORBIDDEN", {
			__message: "Oturumunuzdan çıkılmış",
		})
	throw GezcezError("BAD_REQUEST", { __message: "not implemented." })
}
