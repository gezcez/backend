// networks.controller.ts
// Dashboard catalog reads (plan 7.2) and the provider kill switch (plan 8.9 level 2).

import {
	Body,
	Controller,
	Get,
	HttpCode,
	Inject,
	Param,
	ParseIntPipe,
	Post,
	Req,
} from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { hasPermission, PERMISSION_RESOLVER, type PermissionResolver } from "@common/authorization"
import type { RequestAuth } from "@common/jwt.types"
import { ApiEnvelope, CurrentAuth, RequireScope, UseAuthorization } from "@common/middlewares"
import { AuditService } from "@services/audit/audit.service"
import {
	DashBindingDto,
	DashCityDto,
	DashNetworkDto,
	DashProviderDetailDto,
	DashProviderDto,
	ProviderKillDto,
} from "./networks.dto"
import { NetworksAdminService } from "./networks-admin.service"

@ApiTags("dash: catalog")
@Controller("dash")
export class NetworksController {
	constructor(
		private readonly admin: NetworksAdminService,
		private readonly audit: AuditService,
		@Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
	) {}

	@Get("cities")
	@UseAuthorization({ permission: "catalog.read", scope: "global", description: "List cities" })
	@ApiEnvelope([DashCityDto])
	cities() {
		return this.admin.cities()
	}

	@Get("networks")
	@RequireScope("dash")
	@ApiEnvelope([DashNetworkDto], {
		description: "Networks where the caller holds a role, or all with networks.read.all",
	})
	networks(@CurrentAuth() auth: RequestAuth) {
		const perms = this.permissions.forUser(auth.userId)
		const all = hasPermission(perms, "networks.read.all")
		return this.admin.listNetworks(all ? undefined : (id) => perms.byNetwork.has(id))
	}

	@Get("networks/:networkId")
	@UseAuthorization({
		permission: "catalog.read",
		scope: "network",
		description: "Network profile with bindings",
	})
	@ApiEnvelope(DashNetworkDto)
	network(@Req() req: Request) {
		return this.admin.network(req.networkId!)
	}

	@Get("networks/:networkId/bindings")
	@UseAuthorization({ permission: "catalog.read", scope: "network", description: "Bindings" })
	@ApiEnvelope([DashBindingDto])
	bindings(@Req() req: Request) {
		return this.admin.network(req.networkId!).bindings
	}

	@Get("networks/:networkId/bindings/:bindingId")
	@UseAuthorization({ permission: "catalog.read", scope: "network", description: "One binding" })
	@ApiEnvelope(DashBindingDto)
	binding(@Req() req: Request, @Param("bindingId", ParseIntPipe) bindingId: number) {
		return this.admin.binding(req.networkId!, bindingId)
	}

	@Get("providers")
	@UseAuthorization({ permission: "providers.read", scope: "global", description: "Providers" })
	@ApiEnvelope([DashProviderDto])
	providers() {
		return this.admin.listProviders()
	}

	@Get("providers/:key")
	@UseAuthorization({
		permission: "providers.read",
		scope: "global",
		description: "Adapter detail with config schema, capabilities and credential health",
	})
	@ApiEnvelope(DashProviderDetailDto)
	provider(@Param("key") key: string) {
		return this.admin.provider(key)
	}

	@Post("providers/:key/kill")
	@HttpCode(200)
	@UseAuthorization({
		permission: "providers.kill",
		scope: "global",
		sudo: true,
		description: "Provider kill switch on or off, with a reason",
	})
	@ApiEnvelope(DashProviderDto)
	kill(
		@Param("key") key: string,
		@Body() body: ProviderKillDto,
		@CurrentAuth() auth: RequestAuth,
		@Req() req: Request,
	) {
		const result = this.admin.setProviderEnabled(key, body.enabled, body.reason, auth.userId)
		this.audit.record(body.enabled ? "provider.unkill" : "provider.kill", {
			req,
			target: { type: "provider", id: key },
			data: { reason: body.reason },
		})
		return result
	}
}
