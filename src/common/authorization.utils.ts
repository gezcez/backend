import { OAuthService } from "../services/oauth/oauth.service"
import type {Request} from "express"
import { and, eq } from "drizzle-orm"
import { OAuthRepository } from "../services/oauth/oauth.repository"
import { PermissionsRepository } from "../services/web/repositories/permissions.repository"
import { refreshTokensTable, sudosTable } from "@schemas"
import { buildConfig, OAuthUtils } from "./utils"
import { GezcezError } from "../../../core/src/GezcezError"
export async function handleFetchFromDb(
	req: Request,
	network_id: "global" | (string & {}),
	permission_id: number
) {
	const payload = req["payload"]!
	const network_key = network_id === "global" ? "_" : network_id
	const network_number = network_id === "global" ? 0 : parseInt(network_id)
	const user_permissions = await PermissionsRepository.listUserPermissionsWithNetworkId(
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
const config = buildConfig()
export async function handleSudoMode(req: Request, sudo_key?: string) {
	if (!sudo_key || typeof sudo_key !== "string") {
		throw GezcezError("FORBIDDEN", {
			__message: "Bu işlem için SUDO modunda olmanız lazım.",
			sudo: true,
		})
	}
	const payload = req["payload"]!
	const sudo_row = await OAuthRepository.getSudoRow(sudo_key,payload.sub)
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
	const refresh_token = await OAuthRepository.getRefreshTokenById(
		sudo_row.linked_refresh_token_id,
		payload.sub
	)
	if (!refresh_token)
		throw GezcezError("FORBIDDEN", {
			__message: "Geçersiz oturum",
		})
	if (refresh_token.invalidated_at)
		throw GezcezError("FORBIDDEN", {
			__message: "Oturumunuzdan çıkılmış",
		})
	throw GezcezError("BAD_REQUEST", { __message: "not implemented." })
}
