// shared.controller.ts
import { Controller, Get, Post, Req, Body, Query } from "@nestjs/common"
import { UseGuards } from "@nestjs/common/decorators"
import { ApiHeader } from "@nestjs/swagger"
import {
	AuthenticationGuard,
	AuthorizationGuard,
	buildConfig,
	GezcezError,
	GezcezResponse,
	SYNCED_CONFIG,
	UseNetwork,
} from "@shared"
import type { Request } from "express"
import { UserRepository } from "../user/user.repository"
import { OAuthRepository } from "../oauth/oauth.repository"
import { PermissionsRepository } from "../permissions/permissions.repository"
import { NetworkRepository } from "../network/network.repository"
import { RolesRepository } from "../roles/roles.repository"

const config = buildConfig()

@Controller("dashboard")
@ApiHeader({
	name: "Authorization",
	description: "Bearer token",
	required: true,
})
@UseGuards(
	AuthenticationGuard({
		app_key: "dashboard",
		is_use_refresh_token: false,
	})
)
export class DashboardController {
	@Get("/account/list-networks")
	async getAccountMe(@Req() req: Request) {
		const payload = req["payload"]!
		const user_networks_from_permissions = await PermissionsRepository.listUserNetworks(payload.sub)
		const user_networks_from_networks = await RolesRepository.listUserNetworks(payload.sub)
		const concatted = [...user_networks_from_permissions, ...user_networks_from_networks]
		const cleaned = [...new Set(concatted.map((e) => e.network?.id))]
			.map((net_id) => SYNCED_CONFIG.networks.find((net) => net.id === net_id))
			.filter((e) => e?.id !== 0)
			.filter((e) => !!e)
		return GezcezResponse(
			{
				networks: cleaned.map((e) => ({ name: e.name, id: e.id })),
			},
			200
		)
	}

	@UseNetwork()
	@Get("/:network_id/get-page-buttons")
	async getPageButtons(@Req() req: Request) {
		const payload = req["payload"]!
		const network_id = req["network_id"]
		const user_networks_from_permissions = await PermissionsRepository.listUserPermissionsWithNetworkId(
			payload.sub,
			network_id
		)
		const user_roles = await RolesRepository.listUserRolesWithNetworkId(payload.sub, network_id)
		const role_permissions = user_roles.map(({ role, user_role }) => ({
			role,
			user_role,
			role_permissions: SYNCED_CONFIG.role_permissions.filter((e) => e.role_id === role?.id),
		}))
		const role_permissions_flattened = role_permissions.map((e) => e.role_permissions).flat()
		const concatted = [...user_networks_from_permissions, ...role_permissions_flattened].map(
			(e) => e.permission_id
		)
		const final_permissions = await PermissionsRepository.listPermissionsFromPermissionIds([
			...new Set(concatted),
		])
		return GezcezResponse(
			{
				pages: final_permissions.map((e) => ({
					key: e.key,
					id: e.id,
					description: e.description,
					href: e.page_href || null,
					label: e.page_label || null,
				})),
			},
			200
		)
	}

	@UseNetwork()
	@Get("/:network_id/list-roles")
	async listAllRoles(@Req() req: Request) {
		const payload = req["payload"]!
		const network_id = req["network_id"]
		const all_roles = await RolesRepository.listAllRoles()

		return GezcezResponse({
			roles: all_roles,
		})
	}

	@UseGuards(
		AuthorizationGuard({
			app_key: "dashboard",
			scope: "scoped",
			permission_id: config.permissions.dashboard["users.list"],
		})
	)
	@UseNetwork()
	@Get("/:network_id/get-user-info")
	async getUserInfo(@Req() req: Request, @Query("user_id") user_id: number) {
		if (!user_id) return GezcezError("BAD_REQUEST",{__message:"Kullanıcı bilgisi çekilemedi."})
		const payload = req["payload"]!
		const network_id = req["network_id"]
		const roles = await UserRepository.listUserRolesWithLeftJoin(user_id)
		const user = await OAuthRepository.getUserById(user_id)
		return GezcezResponse({
			user: user,
			roles: roles,
		})
	}
}
