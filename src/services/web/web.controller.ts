// oauth.controller.ts
import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common"
import { NetworkRepository } from "../network/network.repository"
import { PermissionsRepository } from "./repositories/permissions.repository"
import { WebModels } from "./web.dto"
import { and, eq, isNotNull, not } from "drizzle-orm"
import { notEquals } from "class-validator"
import type { Request } from "express"

import { ProvidersRepository } from "./repositories/providers.repository"
import { GezcezError } from "@common/GezcezError"
import { GezcezResponse } from "@common/Gezcez"
import { NetworkGuard } from "@common/middlewares"
import { logger } from "@common/utils"

@Controller("web")
export class WebController {
	@Get("/providers/list")
	async getProviders(req: Request) {
		const providers = await ProvidersRepository.listAll()
		if (!providers)
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: "Error while fetching data providers from database!",
			})
		return GezcezResponse({ providers: providers })
	}

	@UseGuards(NetworkGuard)
	@Post("/privacy/:network_id/opt-out")
	async optOut(@Req() req: Request, @Body() body: WebModels.OptOutDto) {
		const net = req.network_id
		logger.log("opt-out request", net)
		const network = await NetworkRepository.getNetworkWithProvider(net)
		if (!network || !network.provider)
			return GezcezError("BAD_REQUEST", { __message: "Geçersiz network_id" })
		const optouts = []
		for (const optout_key of body.features) {
			const optout = network.provider?.pulled_data.find(
				(e) => e.key === optout_key && e.can_optout
			)
			if (!optout) {
				return GezcezError("BAD_REQUEST", {
					__message: `'${optout_key}' bilgisi network '${network.network.name}/${network.network.id}' için toplanmıyor veya gizlenebilir değil.`,
				})
			}
			optouts.push(optout)
		}
		return GezcezError("NOT_IMPLEMENTED", {
			debug: {
				optout_fields: optouts,
				form: body,
				...network,
			},
		})
		return GezcezResponse(network)
	}

	@Get("/privacy/get-form")
	async getForm(req: Request) {
		const networks = await NetworkRepository.list()
		if (!networks)
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: "Error while fetching data providers from database!",
			})
		return GezcezResponse({ networks: networks })
	}

	@Get("/networks/list")
	async getNetworks(req: Request) {
		const networks = await NetworkRepository.listWithProviders()
		if (!networks || !networks.at(0))
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: "Error while fetching data providers from database!",
			})
		return GezcezResponse({ networks: networks })
	}
}
