// oauth.controller.ts
import { Controller, Get, Param, UseGuards } from "@nestjs/common"
import { NetworkRepository } from "../network/network.repository"
import { ApiHeader } from "@nestjs/swagger"
import { PermissionsRepository } from "../permissions/permissions.repository"
import { AuthorizationGuard, NetworkGuard } from "@shared"
// import { AuthorizationGuard, NetworkGuard } from "@shared"
const dash = require("../../assets/dashboard.html")
@UseGuards(
	AuthorizationGuard({
		app_key: "system",
		permission_id: 2,
		scope: "global",
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
			permission_id: 11,
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
			permission_id: 6,
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
			permission_id: 10,
			scope: "global",
			sudo_mode: true,
		})
	)
	@Get("/sudo-test")
	async sudoTest(req: Request) {
		return await PermissionsRepository.list()
	}
}
