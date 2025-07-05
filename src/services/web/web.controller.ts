// oauth.controller.ts
import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common"
import { NetworkRepository } from "../network/network.repository"
import { PermissionsRepository } from "../permissions/permissions.repository"
import { WebModels } from "./web.dto"
import { and, eq, isNotNull, not } from "drizzle-orm"
import { notEquals } from "class-validator"
import type { Request } from "express"
import {
	GezcezResponse,
	NetworkGuard,
	GezcezError,
} from "@gezcez/common"
import { db } from "../../db"
import { networksTable, providersTable } from "../../schemas"

@Controller("web")
export class WebController {
	@Get("/providers/list")
	async getProviders(req: Request) {
		const providers = await db
			.select({
				id: providersTable.id,
				url: providersTable.url,
				name: providersTable.name,
				image_url: providersTable.image_url,
			})
			.from(providersTable)
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
		console.log("redieved opt-out request", net)
		const [network] = await db
			.select({
				network: {
					id: networksTable.id,
					name: networksTable.name,
					country: networksTable.country,
					provider_id: networksTable.provider_id,
				},
				provider: {
					id: providersTable.id,
					name: providersTable.name,
					url: providersTable.url,
					image_url: providersTable.image_url,
					pulled_data: providersTable.pulled_data,
				},
			})
			.from(networksTable)
			.where(
				and(
					not(eq(networksTable.hide, true)),
					isNotNull(networksTable.provider_id),
					eq(networksTable.id, net)
				)
			)
			.leftJoin(providersTable, eq(providersTable.id, networksTable.id))
			.limit(1)
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
		const networks = await db
			.select({
				network: {
					id: networksTable.id,
					name: networksTable.name,
					country: networksTable.country,
					provider_id: networksTable.provider_id,
				},
				provider: {
					id: providersTable.id,
					name: providersTable.name,
					url: providersTable.url,
					image_url: providersTable.image_url,
					pulled_data: providersTable.pulled_data,
					network_id_defined_by_provider: networksTable.network_id_defined_by_provider,
				},
			})
			.from(networksTable)
			.where(
				and(not(eq(networksTable.hide, true)), isNotNull(networksTable.provider_id))
			)
			.leftJoin(providersTable, eq(providersTable.id, networksTable.id))
		if (!networks)
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: "Error while fetching data providers from database!",
			})
		return GezcezResponse({ networks: networks })
	}

	@Get("/networks/list")
	async getNetworks(req: Request) {
		const networks = await db
			.select({
				network: {
					id: networksTable.id,
					name: networksTable.name,
					country: networksTable.country,
					provider_id: networksTable.provider_id,
					network_id_defined_by_provider: networksTable.network_id_defined_by_provider,
					public_secret: networksTable.network_public_secret,
				},
				provider: {
					id: providersTable.id,
					name: providersTable.name,
					url: providersTable.url,
					image_url: providersTable.image_url,
				},
			})
			.from(networksTable)
			.where(
				and(not(eq(networksTable.hide, true)), isNotNull(networksTable.provider_id))
			)
			.leftJoin(providersTable, eq(providersTable.id, networksTable.provider_id))
		if (!networks)
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: "Error while fetching data providers from database!",
			})
		return GezcezResponse({ networks: networks })
	}
}
