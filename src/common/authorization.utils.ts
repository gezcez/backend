import { buildConfig, GezcezError, IConfig, OAuthUtils } from "@gezcez/common"
import { OAuthService } from "../services/oauth/oauth.service"
import type {Request} from "express"
import { db } from "../db"
import { sudosTable } from "../schemas"
export async function handleFetchFromDb(
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
	const payload_scopes = OAuthUtils.getPermissionIDsFromPayload(
		payload,
		network_key
	)
	if (!payload_scopes.includes(permission_id)) {
		// just in case i remove the upper code by mistake
		throw GezcezError("FORBIDDEN", {
			__message: "Bu işlemi gerçekleştirmek için yetkiniz yok.",
		})
	}
	if (
		!user_permissions.find(
			(e) => e.permission_id === permission_id && e.network_id === network_number
		)
	)
		throw GezcezError("FORBIDDEN", {
			__message:
				"Bu işlemi gerçekleştirmek için gereken yetkiniz kısa süre önce silinmiş.",
		})
}
const config = buildConfig<IConfig>()
export async function handleSudoMode(req: Request, sudo_key?: string) {
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

	if (
		sudo_row.updated_at.getTime() + config.sudo_mode_ttl * 1000 <
		new Date().getTime()
	)
		throw GezcezError("FORBIDDEN", {
			__message: "SUDO işleminizin süresi dolmuş.",
			sudo: true,
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
