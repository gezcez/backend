// oauth.controller.ts
import { Controller, Get, Param, UseGuards } from "@nestjs/common"
import { NetworkRepository } from "../network/network.repository"
import { ApiHeader } from "@nestjs/swagger"
import { PermissionsRepository } from "../permissions/permissions.repository"
import { AuthenticationGuard, AuthorizationGuard, buildConfig, GezcezResponse, NetworkGuard, RELOAD_SYNCED_CONFIG, SYNCED_CONFIG } from "@shared"
import { db } from "../../db"
const config = buildConfig()
// import { AuthorizationGuard, NetworkGuard } from "@shared"
@UseGuards(
	AuthenticationGuard({
		app_key:"system",
		
	})
)
@ApiHeader({
	name: "Authorization",
	description: "Bearer authorization",
	required: true,
})
@Controller("system")
export class SystemController {
	@Get("/networks")
	async getNetworks(req: Request) {
		return await NetworkRepository.list()
	}

	@UseGuards(
		AuthorizationGuard({
			app_key: "system",
			permission_key: "root",
			scope: "global",
		})
	)
	@Get("/get-config")
	async getConfig(req: Request) {
		return GezcezResponse({config:await RELOAD_SYNCED_CONFIG({db:db})})
	}

	@UseGuards(
		AuthorizationGuard({
			app_key: "system",
			permission_key:"permissions.list",
			scope: "global",
		})
	)
	@Get("/permissions/list")
	async listPermissons(req: Request) {
		return await PermissionsRepository.list()
	}

	@UseGuards(
		NetworkGuard,
		AuthorizationGuard({
			app_key: "system",
			permission_key:"sudo",
			scope: "scoped",
			sudo_mode: true,
		})
	)
	@Get("/:network_id/sudo-test")
	async sudoTestWithNetwork(req: Request) {
		return await PermissionsRepository.list()
	}

	@UseGuards(
		AuthorizationGuard({
			app_key: "system",
			permission_key: "sudo",
			scope: "global",
			sudo_mode: true,
		})
	)
	@Get("/sudo-test")
	async sudoTest(req: Request) {
		return await PermissionsRepository.list()
	}
}
