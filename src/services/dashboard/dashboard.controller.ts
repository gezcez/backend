// shared.controller.ts
import { Controller, Get, Post, Req, Body, Query } from "@nestjs/common"
import { UseGuards } from "@nestjs/common/decorators"
import { ApiHeader } from "@nestjs/swagger"

import type { Request } from "express"
import { UserRepository } from "../user/user.repository"
import { OAuthRepository } from "../oauth/oauth.repository"
import { PermissionsRepository } from "../web/repositories/permissions.repository"
import { NetworkRepository } from "../network/network.repository"
import { RolesRepository } from "../roles/roles.repository"
import { DashboardModels } from "./dashboard.dto"
import { AuthenticationGuard, UseAuthorization } from "@common/middlewares"
import { buildConfig, GezcezError, GezcezResponse } from "@gezcez/core"
import { RELOAD_SYNCED_CONFIG, SYNCED_CONFIG } from "@common/utils"

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
		return GezcezResponse ({networks:SYNCED_CONFIG.networks},200)
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

	@UseAuthorization({
		app_key: "dashboard",
		permission_key: "base.access",
		scope: "scoped",
		description: "User can access the base system",
	})
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
					app: e.app,
					key: e.key,
					id: e.id,
					href: e.page_href || null,
					label: e.page_label || null,
				})),
			},
			200
		)
	}

	@UseAuthorization({
		app_key: "dashboard",
		permission_key: "base.roles.read",
		scope: "scoped",
		description: "Can user list all of the roles",
	})
	@Get("/:network_id/roles/list-all")
	async listAllRoles(@Req() req: Request) {
		const all_roles = await RolesRepository.listAllRoles()

		return GezcezResponse({
			roles: all_roles,
		})
	}

	@UseAuthorization({
		app_key: "dashboard",
		scope: "scoped",
		permission_key: "base.users.read",
	})
	@Get("/:network_id/get-user-info")
	async getUserInfo(@Req() req: Request, @Query("user_id") user_id: number) {
		if (!user_id || isNaN(user_id))
			return GezcezError("BAD_REQUEST", { __message: "Kullanıcı bilgisi çekilemedi." })
		const payload = req["payload"]!
		const network_id = req["network_id"]
		const roles = await UserRepository.listUserRolesWithLeftJoin(user_id)
		const user = await OAuthRepository.getUserById(user_id)
		return GezcezResponse({
			user: user,
			roles: roles,
		})
	}

	@UseAuthorization({
		app_key: "dashboard",
		scope: "scoped",
		permission_key: "base.roles.list-permissions",
	})
	@Get("/:network_id/roles/get-permission-matrix")
	async getRolePermissionMatrix(@Req() req: Request, @Query("role_ids") role_ids: string) {
		const formatted_ids = (role_ids || "")
			.split(",")
			.map((e) => parseInt(e))
			.filter((e) => isFinite(e))
		await RELOAD_SYNCED_CONFIG()
		return GezcezResponse({
			role_permissions: SYNCED_CONFIG.role_permissions.filter((e) => {
				if (formatted_ids.length) {
					return formatted_ids.includes(e.role_id)
				}
				return true
			}),
			permissions: SYNCED_CONFIG.permissions,
			roles: SYNCED_CONFIG.roles,
		})
	}

	@UseAuthorization({
		app_key: "dashboard",
		scope: "global",
		permission_key: "base.roles.write",
		description: "Edit role permissions [requires root]",
		sudo_mode: false,
	})
	@Post("/manage/roles/write-permission")
	async addPermissionToRole(@Req() req: Request, @Body() body: DashboardModels.WritePermissionsToRoleDTO) {
		const { operations, role_id } = body
		const results: { error: string | undefined; permission_id: number }[] = []
		for (const operation of operations) {
			if (SYNCED_CONFIG.permissions.find((e) => e.key === "base.roles.write")?.id === operation.permission_id) {
				results.push({ error: "recursion is not allowed", permission_id: operation.permission_id })
				continue
			}
			if (operation.operation_type === "add") {
				const [op_result, op_err] = await RolesRepository.addPermissionToRole({
					executor_id: req.payload["sub"],
					permission_id: operation.permission_id,
					role_id: role_id,
				})
				if (op_err) results.push({ error: op_err, permission_id: operation.permission_id })
			} else if (operation.operation_type === "remove") {
				const [op_result, op_err] = await RolesRepository.removePermissionFromRole({
					executor_id: req.payload["sub"],
					permission_id: operation.permission_id,
					role_id: role_id,
				})
				if (op_err) results.push({ error: op_err, permission_id: operation.permission_id })
			}
		}
		await RELOAD_SYNCED_CONFIG()
		return GezcezResponse({
			results: results,
			__message: results.length ? "OK" : "Tüm işlemler başarıyla gerçekleştirildi.",
		})
	}

	@UseAuthorization({
		scope: "global",
		app_key: "dashboard",
		permission_key: "base.permissions.read",
		description: "List and read all permissions",
	})
	@Get("/manage/permissions/list-all")
	async listAllPermissions(@Req() req: Request) {
		await RELOAD_SYNCED_CONFIG()
		return GezcezResponse({
			permissions: SYNCED_CONFIG.permissions,
		})
	}
	
	@UseAuthorization({
		scope: "global",
		app_key: "dashboard",
		permission_key: "base.permissions.path-registry",
		description: "List and read all path registries",
	})
	@Get("/manage/permissions/get-registry")
	async getPathRegistry(@Req() req: Request) {
		await RELOAD_SYNCED_CONFIG()
		return GezcezResponse({
			permissions:SYNCED_CONFIG.permissions,
			path_registries: SYNCED_CONFIG.path_registries,
		})
	}
}
